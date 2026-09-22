# Convenience wrapper for the Computer Use plugin.
#
# The harness ships its own Node/pnpm under $DSH_HOME; putting them on PATH here
# means every target runs with the same toolchain the plugin is loaded by,
# without depending on the caller's shell setup.
DSH_NODE := $(HOME)/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin
DSH_PNPM := $(HOME)/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs
PKG      := packages/dsh-plugin-cua

export PATH := $(DSH_NODE):$(PATH)
PNPM := node $(DSH_PNPM)

.PHONY: help build engine plugin typecheck check smoke smoke-writes install-profile

help:
	@echo "make build          build the native engine and bundle the plugin"
	@echo "make engine         build only the Swift engine"
	@echo "make plugin         bundle only the TypeScript plugin"
	@echo "make typecheck      tsc --noEmit"
	@echo "make check          typecheck + schema validation + smoke test"
	@echo "make smoke          end-to-end smoke test against the real engine"
	@echo "make smoke-writes   smoke test plus a real pointer move and key press"

build: engine plugin

engine:
	cd $(PKG) && node scripts/build-engine.mjs

plugin:
	cd $(PKG) && $(PNPM) run build:plugin

typecheck:
	cd $(PKG) && $(PNPM) run typecheck

check:
	cd $(PKG) && $(PNPM) run check

smoke:
	cd $(PKG) && node scripts/smoke.mjs

smoke-writes:
	cd $(PKG) && node scripts/smoke.mjs --write
