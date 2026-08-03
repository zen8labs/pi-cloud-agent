SHELL := /bin/sh

.PHONY: help check-env db migrate setup dev verify

help:
	@printf '%s\n' 'make setup  Install dependencies, start Postgres, migrate, and build the local sandbox image.'
	@printf '%s\n' 'make dev    Start Postgres, apply migrations, and run the controller plus web app.'
	@printf '%s\n' 'make verify Run the repository verification gate.'

check-env:
	@test -f .env || (printf '%s\n' 'Missing .env. Run: cp .env.example .env, then fill in the required credentials.' >&2; exit 1)

db:
	docker compose up -d --wait db

migrate: db
	pnpm db:migrate

setup: check-env
	pnpm install --frozen-lockfile
	$(MAKE) migrate
	pnpm sandbox:image

dev: check-env migrate
	pnpm dev

verify:
	pnpm verify
