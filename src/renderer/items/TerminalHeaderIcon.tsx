import { ItemIcon, itemIconClass } from '../sidebar/row-icons';
import { AttentionDot } from '../attention/AttentionDot';
import type { Attention } from '../attention/attention';
import './TerminalHeaderIcon.css';

export function TerminalHeaderIcon({ target, attention = 'idle' }: { target: string | undefined; attention?: Attention }) {
  return <span className={`terminal-header-icon ${itemIconClass('term', target ?? null) ?? ''}`}>
    <span aria-hidden="true"><ItemIcon type="term" target={target ?? null} /></span>
    <AttentionDot state={attention} className="rail-pane-attention" />
  </span>;
}
