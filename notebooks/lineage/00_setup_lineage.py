# ---
# Fabric notebook: 00_setup_lineage
# ---
# Bootstraps the OpenLineage -> Eventhouse lineage pipeline in two steps:
#   1. Deploy the KQL schema (tables, mapping, policies, functions, materialized views).
#   2. Configure the Spark Environment for OpenLineage HTTP transport, then publish it.
#
# Run this once, with the lineage Spark Environment NOT yet attached (it patches and
# publishes that Environment for you). After it completes, attach `lineage-env` to the
# medallion notebooks and run them to start emitting lineage.
#
# This file is the percent-format (# %%) source of the Fabric notebook so it reviews
# cleanly on GitHub. Paste the cells into a Fabric notebook, or import the .py directly.

# %%
# --- Configuration (edit these for your deployment) ---
WORKSPACE_ID   = "<your-workspace-id>"   # lineage workspace
ENVIRONMENT_ID = "<your-environment-id>"   # the lineage-env Spark Environment
QUERY_URI      = "https://<your-eventhouse>.kusto.fabric.microsoft.com"  # Eventhouse query URI
KQL_DB         = "lineage_eh"
OL_TABLE       = "OpenLineageRaw"
OL_MAPPING     = "OpenLineageRaw_mapping"
OL_NAMESPACE   = "fabric-lineage-demo"
FABRIC_BASE    = "https://api.fabric.microsoft.com/v1"

# Paste the contents of eventhouse/lineage_eh_schema.kql here, or read it from a
# OneLake/attached path. Kept as a variable so this cell stays self-contained.
SCHEMA_KQL = r"""
<<< paste the contents of eventhouse/lineage_eh_schema.kql here >>>
"""

# %%
import json, time
import requests

def _token(audience):
    # notebookutils is the current global in Fabric; mssparkutils is the legacy fallback.
    try:
        return notebookutils.credentials.getToken(audience)   # noqa: F821
    except NameError:
        return mssparkutils.credentials.getToken(audience)    # noqa: F821

def kusto_token():
    return _token("kusto")

def fabric_token():
    return _token("pbi")

# %%
# Step 1/2: deploy the KQL schema (tables, mapping, policies, functions, MVs).
script = ".execute database script with (ContinueOnErrors=true) <|\n" + SCHEMA_KQL
resp = requests.post(
    f"{QUERY_URI}/v1/rest/mgmt",
    headers={"Authorization": "Bearer " + kusto_token(), "Content-Type": "application/json"},
    json={"db": KQL_DB, "csl": script},
)
print("schema deploy HTTP", resp.status_code)
print(resp.text[:6000])
resp.raise_for_status()
print("Schema deploy submitted. Review per-command results above for any errors.")

# %%
# Step 2/2: configure the Spark Environment for OpenLineage HTTP transport, then publish.
# The transport posts each RunEvent directly to the Eventhouse streaming-ingestion
# endpoint using the JSON mapping created in step 1 (no Eventstream involved).
spark_props = {
    "spark.openlineage.transport.type": "http",
    "spark.openlineage.transport.url": QUERY_URI,
    "spark.openlineage.transport.endpoint": f"/v1/rest/ingest/{KQL_DB}/{OL_TABLE}",
    "spark.openlineage.transport.urlParams.streamFormat": "SINGLEJSON",
    "spark.openlineage.transport.urlParams.mappingName": OL_MAPPING,
    "spark.openlineage.transport.auth.type": "api_key",
    "spark.openlineage.transport.auth.apiKey": kusto_token(),
    "spark.extraListeners": "io.openlineage.spark.agent.OpenLineageSparkListener",
    "spark.openlineage.namespace": OL_NAMESPACE,
}
body = {
    "instancePool": {"name": "Starter Pool", "type": "Workspace"},
    "dynamicExecutorAllocation": {"enabled": False},
    "sparkProperties": spark_props,
}
base = f"{FABRIC_BASE}/workspaces/{WORKSPACE_ID}/environments/{ENVIRONMENT_ID}"
h = {"Authorization": "Bearer " + fabric_token(), "Content-Type": "application/json"}

r = requests.patch(base + "/staging/sparkcompute", headers=h, json=body)
print("patch sparkcompute HTTP", r.status_code, r.text[:500])
r.raise_for_status()

pub = requests.post(base + "/staging/publish", headers=h, json={})
print("publish HTTP", pub.status_code, pub.text[:500])
pub.raise_for_status()

# Poll publish state (Quick mode is fast; a full publish can take minutes).
final_state = None
for _ in range(120):
    state = requests.get(base, headers={"Authorization": "Bearer " + fabric_token()}).json()
    pd = (state.get("properties") or {}).get("publishDetails") or {}
    final_state = pd.get("state")
    print("publish state:", final_state)
    if final_state in ("Success", "Failed", "Cancelled"):
        break
    time.sleep(15)
if final_state != "Success":
    raise RuntimeError("Environment publish did not succeed: state=" + str(final_state))
print("Bootstrap complete. Attach lineage-env to the medallion notebooks and run them.")
