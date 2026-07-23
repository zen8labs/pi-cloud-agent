# Controller image (FastAPI + worker). The *sandbox* image is Dockerfile.sandbox.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev curl \
 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
# Install runtime deps (resolved from pyproject's [project].dependencies).
RUN pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27" "pydantic>=2.7" \
      "pydantic-settings>=2.3" "sqlalchemy>=2.0" "asyncpg>=0.29" "alembic>=1.13" \
      "e2b>=1.0" "python-json-logger>=2.0" \
      "PyJWT>=2.8" "cryptography>=42.0"

COPY core ./core
COPY profiles ./profiles
COPY runtime ./runtime

EXPOSE 8080
# Single-process deployment: API + embedded worker (AGENT_RUN_WORKER defaults to 1).
CMD ["uvicorn", "core.api.app:app", "--host", "0.0.0.0", "--port", "8080"]
