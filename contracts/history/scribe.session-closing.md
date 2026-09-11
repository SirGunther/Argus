# `scribe.session-closing` 1.0.0

Initial governed Close request from the desktop lifecycle to the Scribe coordinator.

SCRIBE-04B gave the coordinator only one way to learn that work must be released: the supervisor's
graph-wide `lifecycle.drain`, which is application shutdown and terminates the service. A normal
session Close had no governed carrier at all, so finalized rows still held in coordinator memory —
fewer than a full batch, before the partial-idle threshold elapsed — were never admitted and the
session could be sealed past them. This message is that missing seam: it asks the coordinator to
admit its remainder now, independently of the admission policy's idle timer, and it does not end
the service. `scribe.session-flushed` carries the terminal answer.
