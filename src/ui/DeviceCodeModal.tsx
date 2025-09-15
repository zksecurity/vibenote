import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceCodeResponse } from '../auth/github';
import { pollForToken } from '../auth/github';

interface Props {
  device: DeviceCodeResponse;
  onDone: (token: string | null) => void;
  onCancel: () => void;
}

export function DeviceCodeModal({ device, onDone, onCancel }: Props) {
  const [status, setStatus] = useState<'idle' | 'polling' | 'error' | 'success'>('idle');
  const [message, setMessage] = useState<string>('');
  const openedRef = useRef(false);

  // Start polling immediately so user can authorize on the opened page
  useEffect(() => {
    let cancelled = false;
    setStatus('polling');
    (async () => {
      try {
        const token = await pollForToken(device);
        if (cancelled) return;
        if (token) {
          setStatus('success');
          onDone(token);
        } else {
          setStatus('error');
          setMessage('Authorization timed out. Please try again.');
        }
      } catch (e: any) {
        if (cancelled) return;
        setStatus('error');
        setMessage(e?.message || 'Authorization failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, onDone]);

  const prettyCode = useMemo(() => {
    // Format XXXX-XXXX visually
    const uc = device.user_code || '';
    if (uc.includes('-')) return uc.toUpperCase();
    return uc.slice(0, 4).toUpperCase() + '-' + uc.slice(4).toUpperCase();
  }, [device.user_code]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(device.user_code);
      setMessage('Code copied to clipboard');
    } catch {
      setMessage('Copy failed — select the code and copy');
    }
  };

  const openGitHub = () => {
    if (openedRef.current) return;
    openedRef.current = true;
    window.open(device.verification_uri, '_blank', 'noopener');
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Authorize with GitHub</h3>
        <ol style={{ margin: '6px 0 12px 18px', padding: 0, color: 'var(--muted)' }}>
          <li>Tap “Open GitHub”.</li>
          <li>Paste the code below when asked.</li>
        </ol>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <code style={{ fontSize: 24, letterSpacing: 3 }}>{prettyCode}</code>
          <button className="btn" onClick={copyCode}>Copy</button>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
          <a href={device.verification_uri} target="_blank" rel="noreferrer" style={{ color:'var(--accent)' }}>
            {device.verification_uri.replace('https://', '')}
          </a>
          <div className="toolbar" style={{ margin:0 }}>
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn primary" onClick={openGitHub}>Open GitHub</button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          {status === 'polling' && (
            <div style={{ color: 'var(--muted)' }}>Waiting for authorization…</div>
          )}
          {message && (
            <div style={{ color: 'var(--accent)' }}>{message}</div>
          )}
        </div>
      </div>
    </div>
  );
}
