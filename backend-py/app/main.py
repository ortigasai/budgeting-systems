import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers.dash_flow import router as dash_flow_router
from .routers.internal_orders import router as internal_orders_router
from .routers.npc_monitoring import router as npc_monitoring_router
from .routers.reports import router as reports_router
from .routers.gae_report import router as gae_report_router
from .routers.npc_report import router as npc_report_router
from .routers.sap_cache import router as sap_cache_router
from .routers.transfers import router as transfers_router
from .routers.utilization import router as utilization_router
from .services.sap_sync_service import start_scheduled_sync

# App-wide logging baseline - every module's `logging.getLogger(__name__)`
# (see services/sap_sync_service.py) inherits this format/level rather than
# each needing its own config. NSSM redirects this service's stdout to
# backend-py/logs/stdout.log (see deploy/Deploy-IIS.ps1), so this is what
# ends up in that file.
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

app = FastAPI(title="Budgeting System - Phase 2/3 (Utilization Tracking / Transfer & Reallocation)")


# Runs the SAP sync automatically every 10 minutes from here on, instead of
# only ever running when a Budget Officer clicks "Sync from SAP" (see
# services/sap_sync_service.py's start_scheduled_sync) - Overview/
# Reconciliation/Reports stay fresh without anyone needing to remember to
# trigger it, and a slow/failed manual click is no longer the only way this
# data ever updates.
@app.on_event("startup")
def _start_sap_sync_scheduler() -> None:
    start_scheduled_sync()

# Matches the Node backend's app.ts: wide-open CORS for local dev (both
# backends sit behind the same Vite dev proxy anyway - see /api2 in
# frontend/vite.config.ts).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


app.include_router(utilization_router)
app.include_router(transfers_router)
app.include_router(internal_orders_router)
app.include_router(reports_router)
app.include_router(gae_report_router)
app.include_router(npc_report_router)
app.include_router(dash_flow_router)
app.include_router(npc_monitoring_router)
app.include_router(sap_cache_router)
