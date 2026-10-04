/**
 * Offer a generated file to the user. Inside a claude.ai artifact the page
 * cannot download directly, so it goes through the viewer's `downloads`
 * capability (the viewer confirms the save); elsewhere a normal browser
 * download is used.
 */

interface DownloadsApi {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}
interface ClaudeHost {
  use?: (name: string) => Promise<unknown>;
}

let downloadsPromise: Promise<DownloadsApi | null> | null = null;

function hostDownloads(): Promise<DownloadsApi | null> {
  const claude = (window as unknown as { claude?: ClaudeHost }).claude;
  if (!claude?.use) return Promise.resolve(null);
  downloadsPromise ??= claude.use('downloads').then((d) => (d as DownloadsApi | null) ?? null, () => null);
  return downloadsPromise;
}

export async function saveFile(filename: string, data: Blob): Promise<'saved' | 'declined' | 'unavailable'> {
  const downloads = await hostDownloads();
  if (downloads) {
    try {
      await downloads.save({ filename, data });
      return 'saved';
    } catch (err) {
      const code = (err as { code?: string }).code;
      return code === 'declined' || code === 'rate_limited' ? 'declined' : 'unavailable';
    }
  }
  if ((window as unknown as { claude?: ClaudeHost }).claude) return 'unavailable';
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'saved';
}
