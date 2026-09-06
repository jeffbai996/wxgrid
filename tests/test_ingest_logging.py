"""The ingest CLI's own warnings stay; third-party retry chatter does not."""
import logging

from wxgrid import ingest


def test_ingest_quiets_third_party_retry_chatter_and_keeps_its_own():
    # urllib3 logs every retried connection, multiurl announces "attempt 1 of
    # 500" and ecmwf.opendata prints its connection-limit notice on every run;
    # the retry budget in ecmwf_budget.py already owns those decisions.
    for name in ingest.QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.NOTSET)
    ingest.quiet_third_party_loggers()
    assert set(ingest.QUIET_LOGGERS) >= {"urllib3.connectionpool", "multiurl.retry", "ecmwf.opendata.utils"}
    for name in ingest.QUIET_LOGGERS:
        assert logging.getLogger(name).level == logging.ERROR
    assert logging.getLogger("wxgrid.ingest").level in (logging.NOTSET, logging.INFO, logging.DEBUG)
