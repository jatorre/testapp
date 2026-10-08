# Regenerate: python -m venv v && v/bin/pip install pandas pyarrow && v/bin/python gen_fixtures.py tests/python/fixtures
import sys, pandas as pd, numpy as np
out = sys.argv[1]
rng = np.random.default_rng(42)
n = 1000
df = pd.DataFrame({
    "order_id": np.arange(n, dtype="int64"),
    "category": np.array(["Jeans", "Tops", "Shoes", "Socks"])[np.arange(n) % 4],
    "sale_price": np.round((np.arange(n) % 50) + 0.5, 2),
    "created_at": pd.date_range("2024-01-01", periods=n, freq="h", tz="UTC"),
})
df.to_parquet(f"{out}/orders.parquet", index=False, compression="snappy")
df.to_csv(f"{out}/orders.csv", index=False)
print(df.groupby("category")["sale_price"].sum().to_dict())
