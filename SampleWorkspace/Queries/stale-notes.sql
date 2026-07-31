-- stale-notes.sql
-- Notes untouched for more than 30 days. Clicking this file suspends the
-- folder + tag GUI filters and gives full authority to this statement.
SELECT *
  FROM notes
 WHERE age_days > 30
 ORDER BY age_days DESC, path ASC
