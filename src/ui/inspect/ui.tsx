import clsx from 'clsx';
import React, { FC, ReactNode, useState } from 'react';
import { explorerAddress, shortAddress } from './format';

export const Card: FC<{ title?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }> = ({
  title,
  right,
  className,
  children,
}) => (
  <section className={clsx('rounded-lg border border-white/10 bg-slate-950/60 p-4', className)}>
    {title || right ? (
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
        {right}
      </div>
    ) : null}
    {children}
  </section>
);

export const Badge: FC<{
  tone?: 'ok' | 'info' | 'warn' | 'error' | 'muted';
  children: ReactNode;
  className?: string;
}> = ({ tone = 'muted', children, className }) => (
  <span
    className={clsx(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-none',
      {
        ok: 'bg-emerald-500/15 text-emerald-300',
        info: 'bg-sky-500/15 text-sky-300',
        warn: 'bg-amber-500/15 text-amber-300',
        error: 'bg-rose-500/15 text-rose-300',
        muted: 'bg-white/10 text-slate-300',
      }[tone],
      className
    )}
  >
    {children}
  </span>
);

export const Button: FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline'; size?: 'sm' | 'md' }
> = ({ variant = 'outline', size = 'sm', className, ...props }) => (
  <button
    type="button"
    {...props}
    className={clsx(
      'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
      size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
      {
        primary: 'bg-slate-100 text-slate-900 hover:bg-white',
        outline: 'border border-white/15 hover:bg-white/10',
        ghost: 'hover:bg-white/10',
      }[variant],
      className
    )}
  />
);

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-white/10">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
            t.id === value
              ? 'border-slate-100 text-slate-100'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const Stat: FC<{ label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }> = ({
  label,
  value,
  sub,
  className,
}) => (
  <div className={clsx('min-w-0', className)}>
    <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
    <div className="truncate font-mono text-sm tabular-nums">{value}</div>
    {sub ? <div className="truncate text-xs text-slate-400">{sub}</div> : null}
  </div>
);

export const CopyButton: FC<{ text: string; label?: string; className?: string }> = ({
  text,
  label = 'Copy',
  className,
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
};

export const Address: FC<{ address: string; labels?: Record<string, string>; chars?: number; className?: string }> = ({
  address,
  labels,
  chars = 4,
  className,
}) => {
  const label = labels?.[address];
  return (
    <a
      href={explorerAddress(address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={clsx('truncate hover:underline', label ? 'text-slate-200' : 'font-mono text-slate-400', className)}
    >
      {label ?? shortAddress(address, chars)}
    </a>
  );
};

export const TokenIcon: FC<{ src?: string; className?: string }> = ({ src, className }) =>
  src ? (
    <img src={src} alt="" className={clsx('h-5 w-5 shrink-0 rounded-full bg-white/10', className)} />
  ) : (
    <span className={clsx('inline-block h-5 w-5 shrink-0 rounded-full bg-white/10', className)} />
  );

export const levelTone = { ok: 'ok', info: 'info', warn: 'warn', error: 'error' } as const;

export const LevelDot: FC<{ level: 'ok' | 'info' | 'warn' | 'error' }> = ({ level }) => (
  <span
    className={clsx(
      'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
      {
        ok: 'bg-emerald-400',
        info: 'bg-sky-400',
        warn: 'bg-amber-400',
        error: 'bg-rose-500',
      }[level]
    )}
  />
);
