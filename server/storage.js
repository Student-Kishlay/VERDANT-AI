import fs from 'node:fs';
import path from 'node:path';

// Stands in for InsForge S3-compatible Storage the same way server/db.js
// stands in for Postgres — a single seam to swap out when migrating.
export function createStorage(rootDir) {
  return {
    saveUpload(buffer, { workspaceId, fileHash, fileName }) {
      const dir = path.join(rootDir, workspaceId);
      fs.mkdirSync(dir, { recursive: true });
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const relativePath = path.join(workspaceId, `${fileHash}-${safeName}`);
      fs.writeFileSync(path.join(rootDir, relativePath), buffer);
      return relativePath;
    },

    readUpload(relativePath) {
      return fs.readFileSync(path.join(rootDir, relativePath));
    },

    deleteUpload(relativePath) {
      const full = path.join(rootDir, relativePath);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    },
  };
}
