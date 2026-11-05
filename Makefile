.PHONY: install check test build contracts demo deploy backup
install:
	npm run install:all
check:
	npm run typecheck
	npm --prefix apps/site run check
test:
	npm test
build:
	npm run build
contracts:
	bash scripts/contracts.sh test
	bash scripts/contracts.sh lint
	bash scripts/contracts.sh build
demo:
	npm run demo:sim
deploy:
	bash scripts/deploy.sh
backup:
	bash scripts/backup.sh
