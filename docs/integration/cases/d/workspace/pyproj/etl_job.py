"""Minimal PySpark job with deliberate antipatterns (lf-0033 case B fixture)."""
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.builder.appName("case-b").getOrCreate()

orders = spark.read.parquet("s3://bucket/orders")
customers = spark.read.parquet("s3://bucket/customers")

# SPARK001: collect() pulls the whole dataset to the driver
all_rows = orders.collect()

# SPARK009: join without a condition is a Cartesian product
inflated = orders.crossJoin(customers)

# SPARK003: repartition(1) forces a single task
inflated.repartition(1).write.parquet("s3://bucket/out")
