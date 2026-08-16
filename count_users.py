import json

with open("bench-tmp/data.json", "r", encoding="utf-8") as f:
    data = json.load(f)

count = len(data.get("users", []))

with open("bench-tmp/count.txt", "w", encoding="utf-8") as f:
    f.write(str(count))