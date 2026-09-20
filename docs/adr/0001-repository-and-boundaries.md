# ADR 0001 — Repository and responsibility boundaries

**Status:** Accepted

`Raebu/news` is the standalone publishing-engine repository. Consumer websites are clients. GitHub owns product code/rules; PostgreSQL owns editorial truth; Cloudinary owns media assets; AI output is candidate data; the Publisher owns public-state transitions. This prevents editorial activity from becoming source-code commits and limits credential blast radius.
