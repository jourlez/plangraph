# Widget Export Design

## Intent

Teams want to export their widget list to CSV so they can share it in a spreadsheet.

## Goals

- Export all widgets for one workspace as RFC 4180 CSV.
- Columns: `id,name,color,created_at`, in that order.

## Non-goals

- Import. Excel-specific formats.

## Constraints

- Max 50,000 rows per export; above that return error `EXPORT_TOO_LARGE`.
- Dates in ISO 8601 UTC.

## Approach

Stream rows from the store through a pure formatter; the HTTP handler only sets headers.
