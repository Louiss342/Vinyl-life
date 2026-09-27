// 面板归属于播放器所在窗口，关闭时一起收掉窗口监听，避免独立窗口留下悬浮层。
import { setIcon } from 'obsidian';
import { t } from '../core/i18n';

interface QueuePanelHost {
  state(): { queueMode: boolean; hasQueue: boolean; hasCurrent: boolean };
  toggle(): void;
  save(): void;
  load(): void;
  locate(): void;
  clear(): void;
}

export class QueuePanel {
  private el: HTMLElement;
  private toggle: HTMLButtonElement;
  private check: HTMLElement;
  private actions: HTMLButtonElement[] = [];
  private confirm: HTMLElement;
  private doc: Document;
  private win: Window;

  constructor(private anchor: HTMLButtonElement, private host: QueuePanelHost, private onClosed: () => void) {
    this.doc = anchor.ownerDocument;
    this.win = this.doc.defaultView || window;
    this.el = this.doc.body.createDiv({ cls: 'vinyl-queue-panel', attr: { role: 'dialog', 'aria-label': t('player.queueMore') } });
    anchor.setAttribute('aria-expanded', 'true');
    this.toggle = this.el.createEl('button', { cls: 'vinyl-queue-panel-action vinyl-queue-panel-toggle', attr: { role: 'checkbox', 'aria-label': t('player.queueMode') } });
    setIcon(this.toggle.createSpan({ cls: 'vinyl-queue-panel-icon' }), 'list-music');
    this.toggle.createSpan({ text: t('player.queueMode') });
    this.check = this.toggle.createSpan({ cls: 'vinyl-queue-panel-icon vinyl-queue-panel-check', attr: { 'aria-hidden': 'true' } });
    this.toggle.addEventListener('click', () => { host.toggle(); this.sync(); });
    this.action(t('queueNote.save'), 'save', () => host.save());
    this.action(t('queueNote.load'), 'folder-open', () => host.load());
    this.action(t('player.locateCurrent'), 'locate-fixed', () => host.locate());
    const clear = this.action(t('player.clearQueue'), 'list-x', () => {
      this.confirm.removeClass('vinyl-hidden');
      this.position();
      cancel.focus();
    }, false);
    this.confirm = this.el.createDiv({ cls: 'vinyl-queue-panel-confirm vinyl-hidden' });
    this.confirm.createDiv({ text: t('player.clearQueueConfirm') });
    const buttons = this.confirm.createDiv({ cls: 'vinyl-queue-panel-confirm-actions' });
    const cancel = buttons.createEl('button', { text: t('common.cancel'), cls: 'vinyl-queue-panel-action' });
    cancel.addEventListener('click', () => { this.confirm.addClass('vinyl-hidden'); this.position(); clear.focus(); });
    const apply = buttons.createEl('button', { text: t('player.clearQueue'), cls: 'vinyl-queue-panel-action' });
    apply.addEventListener('click', () => { host.clear(); this.close(); });
    this.sync();
    this.position();
    this.doc.addEventListener('pointerdown', this.outside);
    this.doc.addEventListener('keydown', this.keys);
    this.win.addEventListener('resize', this.position);
    this.doc.addEventListener('scroll', this.position, true);
    this.toggle.focus();
  }

  private action(label: string, icon: string, run: () => void, close = true): HTMLButtonElement {
    const button = this.el.createEl('button', { cls: 'vinyl-queue-panel-action' });
    setIcon(button.createSpan({ cls: 'vinyl-queue-panel-icon' }), icon);
    button.createSpan({ text: label });
    button.addEventListener('click', () => { if (close) this.close(); run(); });
    this.actions.push(button);
    return button;
  }

  sync(): void {
    const state = this.host.state();
    this.toggle.setAttribute('aria-checked', String(state.queueMode));
    this.toggle.toggleClass('is-on', state.queueMode);
    this.check.empty();
    if (state.queueMode) setIcon(this.check, 'check');
    this.toggle.setAttribute('aria-description', t(state.queueMode ? 'player.queuePanelOn' : 'player.queuePanelOff'));
    this.actions[0].disabled = !state.hasQueue;
    this.actions[2].disabled = !state.hasCurrent;
    this.actions[3].disabled = !state.hasQueue;
  }

  private position = (): void => {
    const r = this.anchor.getBoundingClientRect();
    const x = Math.max(12, Math.min(this.win.innerWidth - this.el.offsetWidth - 12, r.right - this.el.offsetWidth));
    const y = Math.max(12, Math.min(this.win.innerHeight - this.el.offsetHeight - 12, r.bottom + 8));
    this.el.style.setProperty('--vinyl-panel-x', `${x}px`);
    this.el.style.setProperty('--vinyl-panel-y', `${y}px`);
  };

  private outside = (ev: PointerEvent): void => {
    const target = ev.target as Node | null;
    if (target && !this.el.contains(target) && !this.anchor.contains(target)) this.close(false);
  };

  private keys = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.close(); return; }
    if (ev.key !== 'Tab') return;
    const nodes = Array.from(this.el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      .filter((el) => !el.closest('.vinyl-hidden'));
    if (ev.shiftKey && this.doc.activeElement === nodes[0]) { ev.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!ev.shiftKey && this.doc.activeElement === nodes.at(-1)) { ev.preventDefault(); nodes[0]?.focus(); }
  };

  close(restoreFocus = true): void {
    this.doc.removeEventListener('pointerdown', this.outside);
    this.doc.removeEventListener('keydown', this.keys);
    this.win.removeEventListener('resize', this.position);
    this.doc.removeEventListener('scroll', this.position, true);
    this.el.remove();
    this.anchor.setAttribute('aria-expanded', 'false');
    this.onClosed();
    if (restoreFocus && this.anchor.isConnected) this.anchor.focus();
  }
}
