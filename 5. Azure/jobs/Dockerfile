# valuelens-jobs: build from the REPO ROOT so the shared core is in the context:
#   docker build -f "5. Azure/jobs/Dockerfile" -t ghcr.io/microsoft/valuelens-jobs:<version> .
# No JVM / Spark: the processor runs on DuckDB (shared/python/valuelens_core).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY shared/python /src/shared
RUN pip install /src/shared && rm -rf /src/shared

COPY ["5. Azure/jobs/valuelens_jobs", "/app/valuelens_jobs"]

RUN useradd --uid 10001 --create-home valuelens
USER valuelens

ENTRYPOINT ["python", "-m", "valuelens_jobs"]
CMD ["run"]
