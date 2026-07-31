-- tag-frequency.sql
-- Aggregate rows (no `path` column) are rendered verbatim in the queue.
SELECT tag AS tag, COUNT(*) AS notes
  FROM note_tags
 GROUP BY tag
 ORDER BY notes DESC, tag ASC
