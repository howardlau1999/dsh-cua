# Convenience wrapper for the Computer Use plugin.
#
# The harness ships its own Node/pnpm under the Harness home; when that runtime
# is present it is the toolchain the plugin is loaded by, so prefer it. It is
# installed on demand and is absent on a fresh machine — and `$(HOME)` is not the
# Harness home under MSYS, where `make` resolves it to `/home/<user>` — so fall
# back to `node` and `pnpm` from PATH rather than failing on a path that was
# never there.
DSH_HOME_DIR ?= $(if $(DSH_HOME),$(DSH_HOME),$(HOME)/.dsh)
DSH_RUNTIME  := $(DSH_HOME_DIR)/dsh-runtimes/dsh-primary-runtime/dependencies
DSH_NODE_BIN := $(wildcard $(DSH_RUNTIME)/node/bin)
DSH_PNPM_JS  := $(wildcard $(DSH_RUNTIME)/pnpm/bin/pnpm.mjs)
NODE         := $(if $(DSH_NODE_BIN),$(DSH_NODE_BIN)/node,node)
PNPM         := $(if $(DSH_PNPM_JS),$(NODE) $(DSH_PNPM_JS),pnpm)
PKG          := packages/dsh-plugin-cua

export PATH := $(if $(DSH_NODE_BIN),$(DSH_NODE_BIN):,$(PATH))

.PHONY: help build engine plugin typecheck check smoke smoke-writes

help:
	@echo "make build          build the native engine and bundle the plugin"
	@echo "make engine         build only the native engine (Swift on macOS, .NET on Windows)"
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
