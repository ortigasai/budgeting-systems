"""Tests for the trend's GAE filter and the per-year source helpers
(app/routers/reports.py). A fake session stands in for the database.
"""

from app.models_sap_raw import SapGaePastActualRaw, SapKssbV2Raw
from app.routers.reports import _only_gae, _past_actuals_by_cc_gl, _sap_plan_by_cc_gl


class FakeSession:
    def __init__(self, rows):
        self.rows = rows

    def exec(self, statement):
        return _Result(self.rows)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


def test_only_gae_keeps_only_mapped_pairs():
    values = {("80111201", "61731102"): 10.0, ("99999999", "11111111"): 5.0}
    assert _only_gae(values, {("80111201", "61731102")}) == {("80111201", "61731102"): 10.0}


def test_past_actuals_sum_each_cost_center_gl_across_months():
    rows = [
        SapGaePastActualRaw(cost_center="80111201", gl_account="61731102", fiscal_year=2025, month=1, amount=100.0),
        SapGaePastActualRaw(cost_center="80111201", gl_account="61731102", fiscal_year=2025, month=2, amount=50.0),
    ]
    assert _past_actuals_by_cc_gl(FakeSession(rows), 2025) == {("80111201", "61731102"): 150.0}


def test_sap_plan_sums_each_cost_center_gl_across_months():
    rows = [
        SapKssbV2Raw(cost_center="80111201", gl_account="61731102", fiscal_year=2026, month=1, plan=40.0, commitment=0.0),
        SapKssbV2Raw(cost_center="80111201", gl_account="61731102", fiscal_year=2026, month=2, plan=60.0, commitment=0.0),
    ]
    assert _sap_plan_by_cc_gl(FakeSession(rows), 2026) == {("80111201", "61731102"): 100.0}
