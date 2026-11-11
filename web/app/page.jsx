'use client';
import { useEffect } from 'react';
import { useDashboard } from '../hooks/useDashboard';
import TopBar from '../components/TopBar';
import WorkersPanel from '../components/WorkersPanel';
import TestForm from '../components/TestForm';
import Cards from '../components/Cards';
import ChartsGrid from '../components/ChartsGrid';
import MetricExplorer from '../components/MetricExplorer';
import LogsPanel from '../components/LogsPanel';
import ReportStrip from '../components/ReportStrip';

// Console page: a single shared state (useDashboard); the panels have nothing
// left but their rendering.
export default function Page() {
  const dash = useDashboard();

  // Live drawing: 1/s snapshots, series, selected metric, reset
  useEffect(() => {
    dash.drawAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash.rowsRev, dash.workerIds, dash.seriesVisible, dash.metricName, dash.drawAll]);

  // Redraw on window resize (same as the legacy console)
  useEffect(() => {
    const onResize = () => dash.drawAll();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [dash.drawAll]);

  const rows = dash.rowsRef.current;

  return (
    <>
      <TopBar ledOn={dash.ledOn} workersCount={dash.workers.length} />
      <main className="grid">
        <aside className="rail">
          <WorkersPanel workers={dash.workers} />
          <TestForm
            formStatus={dash.formStatus}
            submitting={dash.submitting}
            onSubmit={dash.submitTest}
            onStop={dash.stopTest}
            workers={dash.workers}
          />
        </aside>
        <section className="stage">
          <Cards rows={rows} canvasRefs={dash.canvasRefs} />
          <ChartsGrid
            workerIds={dash.workerIds}
            seriesVisible={dash.seriesVisible}
            onToggle={dash.setSeriesOn}
            canvasRefs={dash.canvasRefs}
          />
          <MetricExplorer
            rows={rows}
            workerIds={dash.workerIds}
            seriesVisible={dash.seriesVisible}
            metricName={dash.metricName}
            metricNames={dash.metricNames}
            onMetricChange={dash.setMetricName}
            canvasRefs={dash.canvasRefs}
            onToggle={dash.setSeriesOn}
          />
          <LogsPanel
            workerLogsRef={dash.workerLogsRef}
            activeWorker={dash.activeWorker}
            selectWorker={dash.selectWorker}
            totalLogLines={dash.totalLogLines}
            autoScroll={dash.autoScroll}
            setAutoScroll={dash.setAutoScroll}
            clearLogs={dash.clearLogs}
            logviewRef={dash.logviewRef}
            onLogScroll={dash.onLogScroll}
            lastAppendedRef={dash.lastAppendedRef}
            clearedAtRef={dash.clearedAtRef}
          />
          <ReportStrip
            sessions={dash.sessions}
            sessionSelectValue={dash.sessionSelectValue}
            onSessionSelect={dash.onSessionSelect}
            rawWorkerValue={dash.rawWorkerValue}
            setRawWorkerValue={dash.setRawWorkerValue}
            latestSession={dash.latestSession}
            downloadReport={dash.downloadReport}
            downloadRaw={dash.downloadRaw}
          />
        </section>
      </main>
      <div ref={dash.tipRef} className="chart-tip" style={{ display: 'none' }} />
    </>
  );
}
