"""Run every phase in order:  python run_all.py"""
import subprocess, sys
for s in ["01_download_data", "02_network_analysis", "03_service_areas", "04_location_optimization", "05_demo_incidents", "06_export_road_network"]:
    print(f"\n=== {s} ===")
    r = subprocess.run([sys.executable, f"scripts/{s}.py"], env={**__import__('os').environ, "PYTHONPATH": "scripts"})
    if r.returncode: sys.exit(f"Stopped at {s}. Send me the red error text.")
print("\nAll done. Now run:  python server.py")
