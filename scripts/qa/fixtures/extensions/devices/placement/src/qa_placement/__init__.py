import json
import os
import omp

HOST_PID = os.getpid()

def record(name):
    return json.dumps({"host_pid": HOST_PID, "body_pid": os.getpid(), "name": name})

@omp.device("host_probe", place="host")
async def host_probe(marker: str = "host"):
    return record("host_probe")

@omp.device("env_probe", place="env")
async def env_probe(marker: str = "env"):
    return record("env_probe")

@omp.device("worker_probe", place="worker:qa")
async def worker_probe(marker: str = "worker"):
    return record("worker_probe")
