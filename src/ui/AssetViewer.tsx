// Placeholder viewer for binary files (images and other assets).
import type { BinaryFileDoc } from '../storage/local';

type AssetViewerProps = {
  file: BinaryFileDoc;
};

export function AssetViewer({ file }: AssetViewerProps) {
  return (
    <div className="asset-viewer">
      <div className="asset-viewer-header">
        <h2>{file.title || file.path}</h2>
        <p className="asset-viewer-meta">{file.mime || 'binary file'}</p>
      </div>
      <div className="asset-viewer-body">
        <p>This asset preview is not available yet.</p>
        <p className="asset-viewer-path">Path: <code>{file.path}</code></p>
      </div>
    </div>
  );
}
