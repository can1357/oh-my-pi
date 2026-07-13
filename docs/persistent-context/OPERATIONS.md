# Operations and Observability

## Metrics

Track bytes captured/written/read, deduplication ratio, screenshots avoided, policy and quota rejections, queue depth, disk reserve, WAL size, expired-object backlog, deletion outcomes, orphan count, artifact retrieval age, and remote-sync backlog.

## Pressure states

| State | Threshold | Behavior |
|---|---:|---|
| Normal | below 70% budget | configured capture |
| Pressure | 70–85% | stronger dedupe, lower resolution, defer optional work |
| Critical | 85–95% | processed text only; raw persistence disabled |
| Emergency | above 95% or below free-space reserve | reject non-audit writes and clean up |

Return to normal only below 65%.

## Cleanup order

1. orphaned temporary files
2. expired temporary files
3. duplicate raw captures
4. expired raw captures
5. stale thumbnails
6. rebuildable embeddings and caches
7. completed-session processed artifacts
8. nonessential error logs

Never automatically delete active session state, legal holds, unexpired audit records, or user-designated deliverables.

A reconciler must identify files without database records, records without files, zero-reference blobs, stale expiry, partial uploads, stale temp captures, and unbounded WAL growth.
