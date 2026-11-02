// Sizes on the export page. Decimal units (1 MB = 1,000,000 bytes), the ones
// Vercel uses for the Blob data-transfer allowance the ZIPs count toward.

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

/** 850 -> "850 B", 41_234_567 -> "41.2 MB". */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  // Whole bytes have no fraction; larger units keep one decimal.
  const shown = unit === 0 ? String(Math.round(value)) : ONE_DECIMAL.format(value)
  return `${shown} ${UNITS[unit]}`
}

/** "41.2 MB" when exact, "about 41.2 MB" when it is the photos' sum without the ZIP overhead. */
export function formatPartSize(bytes: number, exact: boolean): string {
  return exact ? formatBytes(bytes) : `about ${formatBytes(bytes)}`
}

export function formatPhotoCount(count: number): string {
  return count === 1 ? "1 photo" : `${count.toLocaleString("en-US")} photos`
}
