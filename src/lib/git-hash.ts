// Compute Git blob SHA-1 locally, matching Git's object hashing algorithm.
//
// Git computes blob sha as: SHA-1("blob " + byte_length + "\0" + content)
// where byte_length is the UTF-8 byte length (not string length).

export { computeGitBlobSha, computeGitBlobShaFromBase64 };

/**
 * Compute Git blob SHA-1 from raw string content (UTF-8 encoded).
 */
async function computeGitBlobSha(content: string): Promise<string> {
  let encoder = new TextEncoder();
  let contentBytes = encoder.encode(content);
  return computeGitBlobShaFromBytes(contentBytes);
}

/**
 * Compute Git blob SHA-1 from base64-encoded content.
 */
async function computeGitBlobShaFromBase64(base64Content: string): Promise<string> {
  let contentBytes = base64ToBytes(base64Content);
  return computeGitBlobShaFromBytes(contentBytes);
}

/**
 * Core implementation: compute Git blob SHA-1 from raw bytes.
 */
async function computeGitBlobShaFromBytes(contentBytes: Uint8Array): Promise<string> {
  let header = `blob ${contentBytes.length}\0`;
  let encoder = new TextEncoder();
  let headerBytes = encoder.encode(header);

  // Concatenate header + content
  let combined = new Uint8Array(headerBytes.length + contentBytes.length);
  combined.set(headerBytes, 0);
  combined.set(contentBytes, headerBytes.length);

  // Compute SHA-1
  let hashBuffer = await crypto.subtle.digest('SHA-1', combined);
  let hashArray = new Uint8Array(hashBuffer);

  // Convert to hex string
  return bytesToHex(hashArray);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function base64ToBytes(base64: string): Uint8Array {
  // Handle both browser and Node.js environments
  let binaryString = atob(base64);
  let bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
