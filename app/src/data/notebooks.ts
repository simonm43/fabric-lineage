/**
 * Embedded demo medallion-notebook source (bronze -> silver -> gold -> cross-marts).
 * Shown by the lineage graph's "Show code" action, resolved from a table's job_name.
 * Generated from notebooks/demo-lakehouse/*.ipynb.
 */

export const NOTEBOOK_SOURCE: Record<string, string> = {
  '01_bronze_silver': `# --- Cell 1 ---
from pyspark.sql import functions as F

BRONZE = "taxi_lh.bronze_yellow_taxi"
SILVER = "taxi_lh.silver_yellow_taxi"

# Synthetic NYC-taxi-shaped data — keeps the demo self-contained.
# Lineage will still capture column-level edges through the transformations below.
N_ROWS = 50000

# --- Cell 2 ---
raw = (spark.range(N_ROWS)
    .withColumn("VendorID", (F.col("id") % 3 + 1).cast("int"))
    .withColumn("tpep_pickup_datetime",
                F.to_timestamp(F.lit("2024-01-01")) + F.expr("INTERVAL 1 MINUTE") * (F.col("id") % 43200))
    .withColumn("tpep_dropoff_datetime",
                F.col("tpep_pickup_datetime") + F.expr("INTERVAL 1 MINUTE") * ((F.col("id") % 45) + 5))
    .withColumn("PULocationID", (F.col("id") % 263 + 1).cast("int"))
    .withColumn("DOLocationID", ((F.col("id") * 7) % 263 + 1).cast("int"))
    .withColumn("passenger_count", (F.col("id") % 4 + 1).cast("int"))
    .withColumn("trip_distance", (F.col("id") % 25 + 1).cast("double"))
    .withColumn("fare_amount", (F.col("trip_distance") * 2.5 + 3.0).cast("double"))
    .withColumn("tip_amount", (F.col("fare_amount") * 0.15).cast("double"))
    .withColumn("total_amount", (F.col("fare_amount") + F.col("tip_amount")).cast("double"))
    .withColumn("payment_type", (F.col("id") % 2 + 1).cast("int"))
    .drop("id"))

(raw
    .withColumn("_ingest_ts", F.current_timestamp())
    .write.mode("overwrite")
    .format("delta")
    .saveAsTable(BRONZE))

spark.table(BRONZE).printSchema()

# --- Cell 3 ---
bronze = spark.table(BRONZE)

silver = (bronze
    .where((F.col("trip_distance") > 0) & (F.col("fare_amount") > 0))
    .withColumn("trip_duration_min",
                (F.unix_timestamp("tpep_dropoff_datetime") -
                 F.unix_timestamp("tpep_pickup_datetime")) / 60.0)
    .withColumn("avg_speed_mph",
                F.col("trip_distance") / (F.col("trip_duration_min") / 60.0))
    .select(
        F.col("VendorID").alias("vendor_id"),
        F.col("tpep_pickup_datetime").alias("pickup_ts"),
        F.col("tpep_dropoff_datetime").alias("dropoff_ts"),
        F.col("PULocationID").alias("pickup_zone_id"),
        F.col("DOLocationID").alias("dropoff_zone_id"),
        F.col("passenger_count"),
        F.col("trip_distance"),
        F.col("trip_duration_min"),
        F.col("avg_speed_mph"),
        F.col("fare_amount"),
        F.col("tip_amount"),
        F.col("total_amount"),
        F.col("payment_type"),
    ))

(silver.write
    .mode("overwrite")
    .format("delta")
    .saveAsTable(SILVER))

spark.table(SILVER).limit(5).show()`,
  '02_gold': `# --- Cell 1 ---
from pyspark.sql import functions as F

SILVER       = "taxi_lh.silver_yellow_taxi"
GOLD_REVENUE = "taxi_lh.gold_daily_revenue"
GOLD_ZONES   = "taxi_lh.gold_zone_summary"

silver = spark.table(SILVER)

# --- Cell 2 ---
(silver
    .groupBy(F.to_date("pickup_ts").alias("pickup_date"), "vendor_id")
    .agg(
        F.count("*").alias("trip_count"),
        F.sum("total_amount").alias("revenue"),
        F.sum("tip_amount").alias("tips"),
        F.avg("trip_duration_min").alias("avg_duration_min"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_REVENUE))

# --- Cell 3 ---
(silver
    .groupBy("pickup_zone_id")
    .agg(
        F.count("*").alias("trip_count"),
        F.avg("trip_distance").alias("avg_distance"),
        F.avg("avg_speed_mph").alias("avg_speed_mph"),
        F.sum("total_amount").alias("revenue"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_ZONES))

spark.table(GOLD_REVENUE).limit(5).show()
spark.table(GOLD_ZONES).limit(5).show()

# --- Cell 4 ---
GOLD_HOURLY  = "taxi_lh.gold_hourly_metrics"
GOLD_PAYMENT = "taxi_lh.gold_payment_summary"

(silver
    .withColumn("pickup_hour", F.hour("pickup_ts"))
    .groupBy("pickup_hour")
    .agg(
        F.count("*").alias("trip_count"),
        F.avg("fare_amount").alias("avg_fare"),
        F.avg("trip_distance").alias("avg_distance"),
        F.avg("avg_speed_mph").alias("avg_speed_mph"),
        F.sum("total_amount").alias("revenue"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_HOURLY))

# --- Cell 5 ---
(silver
    .groupBy("payment_type")
    .agg(
        F.count("*").alias("trip_count"),
        F.sum("total_amount").alias("revenue"),
        F.sum("tip_amount").alias("tips"),
        F.avg("tip_amount").alias("avg_tip"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_PAYMENT))

spark.table(GOLD_HOURLY).limit(5).show()
spark.table(GOLD_PAYMENT).limit(5).show()`,
  '03_marts': `# --- Cell 1 ---
from pyspark.sql import functions as F

BRONZE_ZONES   = "taxi_lh.bronze_taxi_zones"
SILVER_ZONES   = "taxi_lh.silver_zones"
SILVER_TAXI    = "taxi_lh.silver_yellow_taxi"
GOLD_ENRICHED  = "taxi_lh.gold_trips_enriched"
GOLD_BOROUGH   = "taxi_lh.gold_borough_revenue"

# --- Cell 2 ---
boroughs = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]
service_zones = ["Yellow Zone", "Boro Zone", "Airports", "EWR"]

zones = (spark.range(1, 264)
    .withColumnRenamed("id", "location_id")
    .withColumn("borough_raw",
        F.element_at(F.lit(boroughs).cast("array<string>"),
                     ((F.col("location_id") % 5) + 1).cast("int")))
    .withColumn("service_zone_raw",
        F.element_at(F.lit(service_zones).cast("array<string>"),
                     ((F.col("location_id") % 4) + 1).cast("int")))
    .withColumn("zone_name_raw",
        F.concat(F.lit("Zone-"), F.lpad(F.col("location_id").cast("string"), 3, "0")))
    .withColumn("_ingest_ts", F.current_timestamp()))

(zones.write.mode("overwrite").format("delta").saveAsTable(BRONZE_ZONES))
spark.table(BRONZE_ZONES).limit(5).show()

# --- Cell 3 ---
(spark.table(BRONZE_ZONES)
    .select(
        F.col("location_id").alias("zone_id"),
        F.upper(F.trim(F.col("borough_raw"))).alias("borough"),
        F.trim(F.col("service_zone_raw")).alias("service_zone"),
        F.trim(F.col("zone_name_raw")).alias("zone_name"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(SILVER_ZONES))

spark.table(SILVER_ZONES).limit(5).show()

# --- Cell 4 ---
trips = spark.table(SILVER_TAXI)
zones = spark.table(SILVER_ZONES)

pickup = zones.alias("pu")
dropoff = zones.alias("do")

enriched = (trips.alias("t")
    .join(pickup,  F.col("t.pickup_zone_id")  == F.col("pu.zone_id"),  "left")
    .join(dropoff, F.col("t.dropoff_zone_id") == F.col("do.zone_id"), "left")
    .select(
        F.col("t.vendor_id"),
        F.col("t.pickup_ts"),
        F.col("t.dropoff_ts"),
        F.col("t.pickup_zone_id"),
        F.col("pu.borough").alias("pickup_borough"),
        F.col("pu.service_zone").alias("pickup_service_zone"),
        F.col("pu.zone_name").alias("pickup_zone_name"),
        F.col("t.dropoff_zone_id"),
        F.col("do.borough").alias("dropoff_borough"),
        F.col("do.service_zone").alias("dropoff_service_zone"),
        F.col("do.zone_name").alias("dropoff_zone_name"),
        F.col("t.passenger_count"),
        F.col("t.trip_distance"),
        F.col("t.trip_duration_min"),
        F.col("t.fare_amount"),
        F.col("t.tip_amount"),
        F.col("t.total_amount"),
        F.col("t.payment_type"),
        F.when(F.col("pu.borough") == F.col("do.borough"),
               F.lit("intra-borough"))
         .otherwise(F.lit("inter-borough")).alias("trip_kind"),
    ))

(enriched.write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_ENRICHED))

spark.table(GOLD_ENRICHED).limit(5).show()

# --- Cell 5 ---
(spark.table(GOLD_ENRICHED)
    .groupBy("pickup_borough", "dropoff_borough", "trip_kind")
    .agg(
        F.count("*").alias("trip_count"),
        F.sum("total_amount").alias("revenue"),
        F.sum("tip_amount").alias("tips"),
        F.avg("trip_distance").alias("avg_distance"),
        F.avg("trip_duration_min").alias("avg_duration_min"),
    )
    .write.mode("overwrite").format("delta")
    .saveAsTable(GOLD_BOROUGH))

spark.table(GOLD_BOROUGH).orderBy(F.desc("revenue")).limit(10).show()`,
  '04_cross_marts': `# --- Cell 1 ---
from pyspark.sql import functions as F

# Upstream (taxi_lh — created by notebooks 01–03)
SILVER_TAXI     = "taxi_lh.silver_yellow_taxi"
GOLD_DAILY      = "taxi_lh.gold_daily_revenue"
GOLD_ZONE       = "taxi_lh.gold_zone_summary"
GOLD_ENRICHED   = "taxi_lh.gold_trips_enriched"
GOLD_BOROUGH    = "taxi_lh.gold_borough_revenue"

# retail_lh marts
R_BRONZE_PART   = "retail_lh.bronze_partners"
R_SILVER_PART   = "retail_lh.silver_partners"
R_BRONZE_PROD   = "retail_lh.bronze_products"
R_SILVER_PROD   = "retail_lh.silver_products"
R_PART_REVENUE  = "retail_lh.gold_partner_revenue"
R_ZONE_MIX      = "retail_lh.gold_zone_partner_mix"
R_PROD_DEMAND   = "retail_lh.gold_product_demand"

# finance_lh marts
F_BRONZE_CC     = "finance_lh.bronze_cost_centers"
F_SILVER_CC     = "finance_lh.silver_cost_centers"
F_VENDOR_PNL    = "finance_lh.gold_vendor_pnl"
F_BOROUGH_MARGIN= "finance_lh.gold_borough_margin"
F_ZONE_PROFIT   = "finance_lh.gold_zone_profitability"
F_SUMMARY       = "finance_lh.gold_finance_summary"

# --- Cell 2 ---
dbs = [r.namespace for r in spark.sql("SHOW DATABASES").collect()]
print("databases:", dbs)
for lh in ("retail_lh", "finance_lh"):
    assert lh in dbs, f"Lakehouse '{lh}' is not attached to this notebook"
    smoke = f"{lh}.__lineage_smoke"
    (spark.range(1, 4).withColumn("checked_at", F.current_timestamp())
        .write.mode("overwrite").format("delta")
        .option("overwriteSchema", "true").saveAsTable(smoke))
    n = spark.table(smoke).count()
    print(f"{smoke}: {n} rows OK")

# --- Cell 3 ---
regions = ["North", "South", "East", "West", "Central"]
tiers   = ["Gold", "Silver", "Bronze"]

partners = (spark.range(1, 21)
    .withColumnRenamed("id", "partner_id")
    .withColumn("partner_name_raw",
        F.concat(F.lit("Partner-"), F.lpad(F.col("partner_id").cast("string"), 3, "0")))
    .withColumn("region_raw",
        F.element_at(F.lit(regions).cast("array<string>"),
                     ((F.col("partner_id") % 5) + 1).cast("int")))
    .withColumn("tier_raw",
        F.element_at(F.lit(tiers).cast("array<string>"),
                     ((F.col("partner_id") % 3) + 1).cast("int")))
    .withColumn("_ingest_ts", F.current_timestamp()))

(partners.write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_BRONZE_PART))
spark.table(R_BRONZE_PART).limit(5).show()

# --- Cell 4 ---
categories = ["Food", "Beverage", "Retail", "Electronics", "Apparel"]

products = (spark.range(1, 51)
    .withColumnRenamed("id", "product_id")
    .withColumn("product_name_raw",
        F.concat(F.lit("Product-"), F.lpad(F.col("product_id").cast("string"), 3, "0")))
    .withColumn("category_raw",
        F.element_at(F.lit(categories).cast("array<string>"),
                     ((F.col("product_id") % 5) + 1).cast("int")))
    .withColumn("unit_price_raw",
        F.round(((F.col("product_id") % 40) + 5).cast("double"), 2))
    .withColumn("_ingest_ts", F.current_timestamp()))

(products.write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_BRONZE_PROD))
spark.table(R_BRONZE_PROD).limit(5).show()

# --- Cell 5 ---
(spark.table(R_BRONZE_PART)
    .select(
        F.col("partner_id"),
        F.trim(F.col("partner_name_raw")).alias("partner_name"),
        F.upper(F.trim(F.col("region_raw"))).alias("region"),
        F.trim(F.col("tier_raw")).alias("tier"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_SILVER_PART))
spark.table(R_SILVER_PART).limit(5).show()

# --- Cell 6 ---
(spark.table(R_BRONZE_PROD)
    .select(
        F.col("product_id"),
        F.trim(F.col("product_name_raw")).alias("product_name"),
        F.upper(F.trim(F.col("category_raw"))).alias("category"),
        F.col("unit_price_raw").alias("unit_price"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_SILVER_PROD))
spark.table(R_SILVER_PROD).limit(5).show()

# --- Cell 7 ---
daily = spark.table(GOLD_DAILY)
part  = spark.table(R_SILVER_PART)

(daily.alias("d")
    .join(part.alias("p"),
          ((F.col("d.vendor_id") % 20) + 1) == F.col("p.partner_id"), "left")
    .select(
        F.col("d.pickup_date"),
        F.col("d.vendor_id"),
        F.col("p.partner_name"),
        F.col("p.region"),
        F.col("p.tier"),
        F.col("d.trip_count"),
        F.col("d.revenue"),
        F.col("d.tips"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_PART_REVENUE))
spark.table(R_PART_REVENUE).limit(5).show()

# --- Cell 8 ---
zones = spark.table(GOLD_ZONE)
prod  = spark.table(R_SILVER_PROD)

(zones.alias("z")
    .join(prod.alias("p"),
          ((F.col("z.pickup_zone_id") % 50) + 1) == F.col("p.product_id"), "left")
    .select(
        F.col("z.pickup_zone_id"),
        F.col("p.product_name"),
        F.col("p.category"),
        F.col("p.unit_price"),
        F.col("z.trip_count"),
        F.col("z.avg_distance"),
        F.col("z.revenue").alias("zone_revenue"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_ZONE_MIX))
spark.table(R_ZONE_MIX).limit(5).show()

# --- Cell 9 ---
enriched = spark.table(GOLD_ENRICHED)
prod     = spark.table(R_SILVER_PROD)

demand = (enriched
    .groupBy("pickup_borough")
    .agg(
        F.count("*").alias("demand_trips"),
        F.avg("fare_amount").alias("avg_fare"),
        F.sum("total_amount").alias("borough_revenue"),
    )
    .withColumn("product_id",
        ((F.abs(F.hash(F.col("pickup_borough"))) % 50) + 1).cast("long")))

(demand.alias("d")
    .join(prod.alias("p"), F.col("d.product_id") == F.col("p.product_id"), "left")
    .select(
        F.col("d.pickup_borough"),
        F.col("p.product_name"),
        F.col("p.category"),
        F.col("d.demand_trips"),
        F.col("d.avg_fare"),
        F.col("d.borough_revenue"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(R_PROD_DEMAND))
spark.table(R_PROD_DEMAND).limit(5).show()

# --- Cell 10 ---
depts = ["Operations", "Logistics", "Sales", "Support", "Finance"]
regions = ["North", "South", "East", "West", "Central"]

cc = (spark.range(1, 11)
    .withColumnRenamed("id", "cost_center_id")
    .withColumn("name_raw",
        F.concat(F.lit("CC-"), F.lpad(F.col("cost_center_id").cast("string"), 2, "0")))
    .withColumn("dept_raw",
        F.element_at(F.lit(depts).cast("array<string>"),
                     ((F.col("cost_center_id") % 5) + 1).cast("int")))
    .withColumn("region_raw",
        F.element_at(F.lit(regions).cast("array<string>"),
                     ((F.col("cost_center_id") % 5) + 1).cast("int")))
    .withColumn("fixed_cost_raw",
        F.round(((F.col("cost_center_id") % 7) + 2).cast("double") * 1000.0, 2))
    .withColumn("_ingest_ts", F.current_timestamp()))

(cc.write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_BRONZE_CC))
spark.table(F_BRONZE_CC).limit(5).show()

# --- Cell 11 ---
(spark.table(F_BRONZE_CC)
    .select(
        F.col("cost_center_id"),
        F.trim(F.col("name_raw")).alias("cost_center_name"),
        F.upper(F.trim(F.col("dept_raw"))).alias("department"),
        F.upper(F.trim(F.col("region_raw"))).alias("region"),
        F.col("fixed_cost_raw").alias("fixed_cost"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_SILVER_CC))
spark.table(F_SILVER_CC).limit(5).show()

# --- Cell 12 ---
rev   = spark.table(R_PART_REVENUE)
daily = spark.table(GOLD_DAILY)
cc    = spark.table(F_SILVER_CC)

partner_rev = (rev
    .groupBy("region", "tier")
    .agg(
        F.sum("revenue").alias("partner_revenue"),
        F.sum("tips").alias("partner_tips"),
        F.sum("trip_count").alias("partner_trips"),
    ))

taxi_rev = (daily
    .agg(
        F.sum("revenue").alias("taxi_revenue"),
        F.avg("avg_duration_min").alias("avg_duration_min"),
    ))

(partner_rev.alias("r")
    .join(cc.alias("c"), F.col("r.region") == F.col("c.region"), "left")
    .crossJoin(taxi_rev.alias("t"))
    .select(
        F.col("r.region"),
        F.col("r.tier"),
        F.col("c.department"),
        F.col("r.partner_revenue"),
        F.col("r.partner_tips"),
        F.col("r.partner_trips"),
        F.col("c.fixed_cost"),
        (F.col("r.partner_revenue") - F.col("c.fixed_cost")).alias("net_profit"),
        F.col("t.taxi_revenue"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_VENDOR_PNL))
spark.table(F_VENDOR_PNL).limit(10).show()

# --- Cell 13 ---
borough = spark.table(GOLD_BOROUGH)
cc      = spark.table(F_SILVER_CC)

cc_avg = cc.agg(F.avg("fixed_cost").alias("avg_fixed_cost"))

(borough.alias("b")
    .crossJoin(cc_avg.alias("c"))
    .select(
        F.col("b.pickup_borough"),
        F.col("b.dropoff_borough"),
        F.col("b.trip_kind"),
        F.col("b.trip_count"),
        F.col("b.revenue"),
        F.col("c.avg_fixed_cost"),
        (F.col("b.revenue") - F.col("c.avg_fixed_cost")).alias("margin"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_BOROUGH_MARGIN))
spark.table(F_BOROUGH_MARGIN).orderBy(F.desc("margin")).limit(10).show()

# --- Cell 14 ---
mix  = spark.table(R_ZONE_MIX)
zone = spark.table(GOLD_ZONE)

(mix.alias("m")
    .join(zone.alias("z"), F.col("m.pickup_zone_id") == F.col("z.pickup_zone_id"), "left")
    .select(
        F.col("m.pickup_zone_id"),
        F.col("m.category"),
        F.col("m.unit_price"),
        F.col("z.trip_count"),
        F.col("z.avg_speed_mph"),
        F.col("m.zone_revenue"),
        (F.col("m.zone_revenue") / (F.col("z.trip_count") + F.lit(1))).alias("revenue_per_trip"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_ZONE_PROFIT))
spark.table(F_ZONE_PROFIT).limit(5).show()

# --- Cell 15 ---
(spark.table(F_VENDOR_PNL)
    .groupBy("department")
    .agg(
        F.sum("partner_revenue").alias("total_revenue"),
        F.sum("fixed_cost").alias("total_cost"),
        F.sum("net_profit").alias("total_net_profit"),
        F.sum("partner_trips").alias("total_trips"),
    )
    .write.mode("overwrite").format("delta")
    .option("overwriteSchema", "true").saveAsTable(F_SUMMARY))
spark.table(F_SUMMARY).orderBy(F.desc("total_net_profit")).show()`,
};
