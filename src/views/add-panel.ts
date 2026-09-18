// 专辑墙「添加」浮层（工具栏方案 2026-09-18）：一个浮层、两种入库方式，两层视图 ——
//   第一层：在线搜索（views/album-search 的 AlbumSearchPane）+ 底部本地入口（拖音频 / 选择文件）；
//   第二层：本地导入（views/local-import-pane 的 LocalImportPane）—— 拖进来的文件与「选择文件」
//           都落到这一层：选目标、选落库方式，再按「开始导入」；导完清空、留在原地接着导下一批。
// 旧的本机导入弹窗仍在（卡片右键「导入本地音频…」与命令面板用），两边共用同一个面板实现 ——
// 从工具栏进来不再弹第二个窗口，自然也不会有两套界面互相遮挡。
// 面板只负责内容与自己的标题栏（图标芯片 + 标题，学设置页的分区块）；位置 / 单开一个 / 点外关闭
// 由 shelf-view 的面板管理统一处理。
import { setIcon, TFile } from 'obsidian';
import { AlbumInfo } from '../core/album-index';
import { ImportContext } from '../import';
import { collectDroppedFiles, droppedRootName, isAudioFile } from '../util';
import { t } from '../core/i18n';
import { AlbumSearchPane } from './album-search';
import { LocalImportPane } from './local-import-pane';

export interface AddPanelHost {
  /** 打开一张笔记（搜索结果里点「打开」/ 直连链接导入成功） */
  openFile(file: TFile): void;
  /** 搜索结果刚入库一张（专辑墙拿它给新卡片描边） */
  onImported(file: TFile): void;
  /** 本地导入写进了一张专辑（同上，按笔记路径描边） */
  onLocalDone(path: string): void;
  /** 关掉浮层（面板头右上角的 ×） */
  close(): void;
}

export class AddPanel {
  private pane: AlbumSearchPane;
  private localPane: LocalImportPane;
  private headEl: HTMLElement | null = null;
  private searchLayer: HTMLElement | null = null;
  private localLayer: HTMLElement | null = null;
  private layer: 'search' | 'local' = 'search';

  constructor(
    ctx: ImportContext,
    albums: AlbumInfo[],
    private host: AddPanelHost
  ) {
    this.pane = new AlbumSearchPane(ctx, {
      openFile: (file) => this.host.openFile(file),
      onImported: (file) => this.host.onImported(file),
    });
    this.localPane = new LocalImportPane(ctx, albums, undefined, {
      onDone: ({ album }) => {
        if (album) this.host.onLocalDone(album.path); // 新卡片描一下边（看不见就算了）
        this.localPane.reset(); // 浮层留在原地：接着导下一批
      },
    });
  }

  /** 画进浮层容器：标题栏 + 两个层（另一层用 vinyl-hidden 收着，状态原地保留） */
  mount(container: HTMLElement): void {
    this.headEl = container.createDiv({ cls: 'vinyl-panel-head' });
    this.searchLayer = container.createDiv({ cls: 'vinyl-panel-body vinyl-add-body' });
    this.pane.mount(this.searchLayer, { withButton: false, placeholder: t('add.placeholder') });
    this.mountLocalZone(this.searchLayer);
    this.localLayer = container.createDiv({ cls: 'vinyl-panel-body vinyl-local-layer vinyl-hidden' });
    this.localPane.mount(this.localLayer);
    this.showLayer('search');
  }

  /** 带入关键词并立即搜一轮（专辑墙空态的「在线查找『词』」） */
  prefill(query: string): void {
    this.showLayer('search');
    this.pane.prefill(query);
  }

  focus(): void {
    if (this.layer === 'local') return; // 本地层自己会把焦点放到选择按钮上
    this.pane.focus();
  }

  destroy(): void {
    this.pane.destroy();
    this.localPane.destroy();
  }

  // ============ 两层之间切换 ============

  private showLayer(layer: 'search' | 'local'): void {
    this.layer = layer;
    this.searchLayer?.toggleClass('vinyl-hidden', layer !== 'search');
    this.localLayer?.toggleClass('vinyl-hidden', layer !== 'local');
    this.buildHead();
  }

  /** 标题栏：本地层是「‹ 返回添加」+ 标题，搜索层是图标芯片 + 标题；两层都有 ×（关浮层） */
  private buildHead(): void {
    const head = this.headEl;
    if (!head) return;
    head.empty();
    const local = this.layer === 'local';
    if (local) {
      const back = head.createEl('button', { cls: 'vinyl-panel-back' });
      const backIcon = back.createSpan({ cls: 'vinyl-panel-back-icon' });
      setIcon(backIcon, 'chevron-left');
      back.createSpan({ text: t('add.back') });
      back.addEventListener('click', () => this.showLayer('search'));
    } else {
      const icon = head.createSpan({ cls: 'vinyl-panel-icon' });
      setIcon(icon, 'plus');
    }
    head.createDiv({ text: local ? t('import.localTitle') : t('add.title'), cls: 'vinyl-panel-title' });
    const close = head.createEl('button', { cls: 'clickable-icon vinyl-panel-close' });
    setIcon(close, 'x');
    close.setAttribute('aria-label', t('common.close'));
    close.addEventListener('click', () => this.host.close());
  }

  // ============ 第一层：底部的本地入口 ============

  private mountLocalZone(parent: HTMLElement): void {
    const zone = parent.createDiv({ cls: 'vinyl-add-local' });
    zone.createSpan({ text: t('add.localHint'), cls: 'vinyl-add-local-hint' });
    const btn = zone.createEl('button', { text: t('add.chooseFiles'), cls: 'vinyl-add-choose' });
    btn.addEventListener('click', () => {
      // 一步到位：切到本地层就把系统选择器弹出来（取消也无妨，那一层本来就是选文件的地方）
      this.showLayer('local');
      this.localPane.pickFiles();
    });

    zone.addEventListener('dragover', (ev) => {
      if (!hasAudioFiles(ev)) return;
      ev.preventDefault();
      zone.addClass('is-drag-over');
    });
    zone.addEventListener('dragleave', () => zone.removeClass('is-drag-over'));
    zone.addEventListener('drop', (ev) => {
      void (async () => {
        ev.preventDefault();
        zone.removeClass('is-drag-over');
        if (!ev.dataTransfer) return;
        const picked = await collectDroppedFiles(ev.dataTransfer);
        if (!picked.length) return;
        // 拖进来的也进本地层：选目标 / 落库方式都在那边（不再带着看不见的默认值直接入库）
        this.showLayer('local');
        this.localPane.takeFiles(
          picked.map((p) => p.file),
          droppedRootName(picked)
        );
      })();
    });
  }
}

/** 拖进来的是音频文件或文件夹（目录的 dataTransfer item type 为空）——与专辑墙网格的判定同一套 */
function hasAudioFiles(ev: DragEvent): boolean {
  const items = Array.from(ev.dataTransfer?.items || []);
  if (items.some((it) => it.kind === 'file' && !it.type)) return true;
  return Array.from(ev.dataTransfer?.files || []).some((f) => isAudioFile(f.name));
}
