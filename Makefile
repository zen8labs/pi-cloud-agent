.PHONY: install dev test test-unit test-live lint compile run up down sandbox-template web-dev

# All Python sources live under agent/ (pyproject, packages, Dockerfiles, e2b
# config). The web client lives under web/. Targets cd into the relevant part.

install:
	cd agent && pip install -e ".[dev]"

dev:  ## run the controller locally (API + embedded worker)
	cd agent && uvicorn core.api.app:app --reload --host 0.0.0.0 --port 8080

run: dev

test:
	cd agent && pytest -q -m "not live"

test-unit: test

test-live:
	cd agent && pytest -q -m live

lint:
	cd agent && ruff check core bundles runtime

compile:  ## fast syntax check without deps
	cd agent && python -m py_compile $$(find core bundles runtime -name '*.py')

up:  ## bring up Postgres + controller via docker compose
	docker compose up --build

down:
	docker compose down

sandbox-template:  ## build/publish the E2B sandbox template from Dockerfile.sandbox
	cd agent && e2b template build -c "python -m runtime.entrypoint" -d Dockerfile.sandbox --name coreview-agent

web-dev:  ## run the web app locally
	cd web && npm run dev
