export {};

declare global {
  interface HTMLElement {
    __vinylLift?: Animation | null;
    __vinylReturn?: Animation | null;
  }

  interface File {
    path?: string;
    relPath?: string;
    webkitRelativePath?: string;
  }

  interface DataTransferItem {
    webkitGetAsEntry?: () => FileSystemEntry | null;
  }

  interface FileSystemEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
  }

  interface FileSystemFileEntry extends FileSystemEntry {
    file(success: (file: File) => void, error: (reason?: unknown) => void): void;
  }

  interface FileSystemDirectoryReader {
    readEntries(
      success: (entries: FileSystemEntry[]) => void,
      error: (reason?: unknown) => void
    ): void;
  }

  interface FileSystemDirectoryEntry extends FileSystemEntry {
    createReader(): FileSystemDirectoryReader;
  }
}
