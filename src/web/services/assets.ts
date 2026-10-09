import { services } from './http';
export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function previewPath(path: string) {
  return (await services.call('previews.file', { path })).url;
}
export async function resolveImage(reference: string, notePath: string) {
  const path = reference.startsWith('/') ? reference : `${notePath.slice(0, notePath.lastIndexOf('/'))}/${reference}`;
  return previewPath(path);
}
export async function saveDroppedImage(directory: string, name: string, data: ArrayBuffer) {
  const saved = await services.call('files.upload', { directory, name, data: bytesToBase64(new Uint8Array(data)) });
  return saved.name;
}
