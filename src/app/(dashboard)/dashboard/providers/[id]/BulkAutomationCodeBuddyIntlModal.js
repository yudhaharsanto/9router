"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Select } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const BASE = "/api/oauth/codebuddy-intl/bulk-import";
const PLACEHOLDER = `akun1@gmail.com|password1\nakun2@gmail.com:password2`;

function statusColor(status) {
  if (status === "success") return "text-green-400";
  if (status === "failed" || status?.startsWith("failed")) return "text-red-400";
  if (status === "needs_manual") return "text-amber-400";
  if (status === "cancelled") return "text-text-muted";
  return "text-text-muted";
}

export default function BulkAutomationCodeBuddyIntlModal({ isOpen, onClose, onSuccess, proxyPools }) {
  const NONE_VALUE = "__none__";
  const [accountsText, setAccountsText] = useState("");
  const [concurrency, setConcurrency] = useState("1");
  const [proxyPoolId, setProxyPoolId] = useState(NONE_VALUE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const fetchJob = async (jobId) => {
    const res = await fetch(`${BASE}/${jobId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
    return data.job;
  };

  const pollJob = (jobId) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const next = await fetchJob(jobId);
        setJob(next);
        if (next?.status === "completed" || next?.status === "failed" || next?.status === "cancelled") {
          stopPolling();
          if (typeof onSuccess === "function") onSuccess();
        }
      } catch {
        // keep polling; transient preview capture can fail
      }
    }, 2000);
  };

  useEffect(() => stopPolling, []);

  const handleClose = () => {
    if (submitting) return;
    stopPolling();
    setAccountsText("");
    setError("");
    setJob(null);
    onClose();
  };

  const handleStart = async () => {
    setError("");
    const accounts = accountsText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!accounts.length) {
      setError(translate("Enter at least one account"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts,
          concurrency: Number.parseInt(concurrency, 10) || 1,
          ...(proxyPoolId !== NONE_VALUE ? { proxyPoolIds: [proxyPoolId] } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      setJob(data.job);
      pollJob(data.job.jobId);
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!job?.jobId) return;
    try {
      await fetch(`${BASE}/${job.jobId}/cancel`, { method: "POST" });
      const next = await fetchJob(job.jobId);
      setJob(next);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleManual = async (workerId) => {
    if (!job?.jobId || !workerId) return;
    try {
      const res = await fetch(`${BASE}/${job.jobId}/manual/${workerId}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      if (data.job) setJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const summary = job?.summary;
  const running = job && (job.status === "running" || job.status === "queued" || job.status === "needs_manual");

  return (
    <Modal isOpen={isOpen} title={translate("CodeBuddy Intl Automation")} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        {!job && (
          <>
            <p className="text-xs text-text-muted">
              {translate("One Google account per line: email|password. Camoufox browser logs in via the same CodeBuddy Intl device flow, proxy per account round-robin.")}
            </p>
            <textarea
              className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[160px] focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={PLACEHOLDER}
              value={accountsText}
              onChange={(e) => setAccountsText(e.target.value)}
              disabled={submitting}
            />
            <div className="flex gap-2">
              <Select
                label="Concurrency"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
              />
              <Select
                label="Proxy Pool"
                value={proxyPoolId}
                onChange={(e) => setProxyPoolId(e.target.value)}
                options={[
                  { value: NONE_VALUE, label: "None" },
                  ...((proxyPools || []).map((pool) => ({ value: pool.id, label: pool.name }))),
                ]}
                placeholder="None"
              />
            </div>
          </>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {job && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span>Status: <b>{job.status}</b></span>
              {summary && (
                <>
                  <span>Total: {summary.total}</span>
                  <span className="text-green-400">OK: {summary.success}</span>
                  <span className="text-red-400">Fail: {summary.failed}</span>
                  <span className="text-amber-400">Manual: {summary.needs_manual}</span>
                </>
              )}
            </div>
            <ul className="rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono max-h-64 overflow-y-auto flex flex-col gap-2">
              {(job.accounts || []).map((a) => (
                <li key={a.line} className="border-b border-accent/10 pb-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>[{a.line}] {a.email}</span>
                    <span className={statusColor(a.status)}>{a.status}</span>
                    {a.currentStep && <span className="text-text-muted">{a.currentStep}</span>}
                    {a.status === "needs_manual" && a.workerId && (
                      <button
                        type="button"
                        className="text-primary underline"
                        onClick={() => handleManual(a.workerId)}
                      >
                        {translate("Open browser")}
                      </button>
                    )}
                  </div>
                  {a.error && <div className="text-red-400 break-words">{a.error}</div>}
                  {(a.logs || []).slice(-3).map((log) => (
                    <div key={log.id} className="text-text-muted break-words">
                      {log.step}: {log.message}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          {!job ? (
            <Button onClick={handleStart} fullWidth disabled={submitting || !accountsText.trim()}>
              {submitting ? translate("Starting...") : translate("Start Automation")}
            </Button>
          ) : (
            running && (
              <Button onClick={handleCancel} fullWidth variant="secondary">
                {translate("Cancel Job")}
              </Button>
            )
          )}
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BulkAutomationCodeBuddyIntlModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
  proxyPools: PropTypes.array,
};
