import React, { useId } from 'react';

type ToggleProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
};

export { Toggle };

function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descId = `${id}-desc`;
  return (
    <div className={`toggle ${disabled ? 'disabled' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        className={`toggle-switch ${checked ? 'on' : 'off'}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-thumb" />
      </button>
      <div className="toggle-text">
        <div id={labelId} className="toggle-label">
          {label}
        </div>
        {description ? (
          <div id={descId} className="toggle-subtext">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}
