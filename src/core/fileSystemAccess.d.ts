/**
 * The parts of the File System Access API that TypeScript 5.9's DOM library
 * does not declare yet. Only what the library code calls, and everything
 * optional, because none of it exists outside Chromium: Firefox and Safari
 * have declined to ship `showDirectoryPicker`, and directory `move()` is not
 * in stable Chrome at all (see research/2026-09-26-file-library/
 * file-system-access.md). Declaring these as optional forces every call site
 * to feature-detect instead of assuming.
 */

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
  queryPermission?(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission?(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface FileSystemFileHandle {
  /** Chrome 111+ for user-visible files. Silently OVERWRITES an existing
   *  destination — callers check for collisions first. */
  move?(
    destination: FileSystemDirectoryHandle,
    newName: string,
  ): Promise<void>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: FileSystemPermissionMode;
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker?(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}
