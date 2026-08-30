// In-memory stand-in for server/storage.js's real InsForge-bucket-backed
// store — same reasoning as fake-insforge.js: tests need an isolated,
// no-network substitute with the exact same interface.
export function createFakeStorage() {
  const objects = new Map();

  return {
    async saveUpload(buffer, { workspaceId, fileHash, fileName }) {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `${workspaceId}/${fileHash}-${safeName}`;
      objects.set(key, buffer);
      return key;
    },
    async readUpload(key) {
      return objects.get(key);
    },
    async deleteUpload(key) {
      objects.delete(key);
    },
    async saveReport(buffer, { workspaceId, reportId, extension }) {
      const key = `${workspaceId}/${reportId}${extension}`;
      objects.set(key, buffer);
      return key;
    },
    async readReport(key) {
      return objects.get(key);
    },
  };
}
