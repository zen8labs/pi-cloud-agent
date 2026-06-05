.PHONY: install dev test lint compile run up down sandbox-template

install:
	pip install -e ".[dev]"

dev:  ## run the controller locally (API + embedded worker)
	uvicorn core.api.app:app --reload --host 0.0.0.0 --port 8080

run: dev

test:
	pytest -q -m "not live"

test-unit: test

test-live:
	pytest -q -m live

lint:
	ruff check core bundles runtime

compile:  ## fast syntax check without deps
	python -m py_compile $$(find core bundles runtime -name '*.py')

up:  ## bring up Postgres + controller via docker compose
	docker compose up --build

down:
	docker compose down

sandbox-template:  ## build/publish the E2B sandbox template from Dockerfile.sandbox
	e2b template build -c "python -m runtime.entrypoint" -d Dockerfile.sandbox --name coreview-agent

web-dev:  ## run the web app locally
	cd web && npm run dev
