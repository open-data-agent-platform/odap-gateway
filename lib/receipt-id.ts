export const maxReceiptIdLength = "denied_preapproval_".length + 128;

export function isReceiptId(id: string) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) || /^denied_preapproval_[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(id);
}

export function receiptPathId(segment: string) {
  try {
    const id = decodeURIComponent(segment);
    return isReceiptId(id) ? id : null;
  } catch { return null; }
}
