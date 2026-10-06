# valuelens-jobs: build from the REPO ROOT so the shared core and SQL migrations are in the context:
#   docker build -f "5. Azure/jobs/Dockerfile" -t ghcr.io/microsoft/valuelens-jobs:<version> .
# No JVM / Spark: the processor runs on DuckDB (shared/python/valuelens_core).
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    VALUELENS_MIGRATIONS_DIR=/app/sql/migrations
WORKDIR /app

# Microsoft ODBC Driver 18 for SQL Server (pyodbc + Entra access token).
# libgssapi-krb5-2 is a runtime dep of the driver that isn't declared; without it autoremove drops it with curl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg ca-certificates unixodbc libgssapi-krb5-2 \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
 && echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/mssql-release.list \
 && apt-get update \
 && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && ! ldd /opt/microsoft/msodbcsql18/lib64/libmsodbcsql-18.*.so.* | grep "not found"

COPY ["5. Azure/jobs/requirements.txt", "/app/requirements.txt"]
RUN pip install -r /app/requirements.txt

COPY shared/python /src/shared
RUN pip install /src/shared && rm -rf /src/shared

COPY ["5. Azure/sql/migrations", "/app/sql/migrations"]
COPY ["5. Azure/jobs/valuelens_jobs", "/app/valuelens_jobs"]

RUN useradd --uid 10001 --create-home valuelens
USER valuelens

ENTRYPOINT ["python", "-m", "valuelens_jobs"]
CMD ["run"]