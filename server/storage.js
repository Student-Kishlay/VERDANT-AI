// InsForge Storage-backed file store — replaces the local-disk version that
// stood in for InsForge S3-compatible Storage during earlier milestones.
// Same interface (saveUpload/readUpload/deleteUpload/saveReport/readReport),
// now backed by real buckets (raw-uploads, reports) via the admin API key.
// fetch() follows the storage API's redirect to its CDN transparently, so
// readUpload/readReport just return the bytes.
export function createStorage(bucket, { baseUrl, apiKey } = {}) {
  const base = baseUrl || process.env.INSFORGE_PROJECT_URL;
  const key = apiKey || process.env.INSFORGE_SERVICE_ROLE_KEY;

  async function upload(buffer, objectKey) {
    const form = new FormData();
    form.append('file', new Blob([buffer]), objectKey.split('/').pop());
    const res = await fetch(`${base}/api/storage/buckets/${bucket}/objects/${objectKey}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) throw new Error(`InsForge storage upload failed (${res.status}): ${await res.text()}`);
    return objectKey;
  }

  async function download(objectKey) {
    const res = await fetch(`${base}/api/storage/buckets/${bucket}/objects/${objectKey}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`InsForge storage download failed (${res.status}) for ${objectKey}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function remove(objectKey) {
    await fetch(`${base}/api/storage/buckets/${bucket}/objects/${objectKey}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  return {
    async saveUpload(buffer, { workspaceId, fileHash, fileName }) {
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const objectKey = `${workspaceId}/${fileHash}-${safeName}`;
      return upload(buffer, objectKey);
    },
    readUpload: download,
    deleteUpload: remove,

    async saveReport(buffer, { workspaceId, reportId, extension }) {
      const objectKey = `${workspaceId}/${reportId}${extension}`;
      return upload(buffer, objectKey);
    },
    readReport: download,
  };
}
