# Studio Content Types Reference

NotebookLM Studio can generate multiple output formats from notebook sources. All use the same `studio_create` → `studio_status` → `download_artifact` workflow.

## Content Types

### audio
**Best for:** Commute listening, passive review, accessibility
**Output:** MP3 podcast-style overview with two AI hosts
**Duration:** 5-15 minutes depending on source length
**Notes:** The flagship NotebookLM feature. Produces conversational audio that covers key points from all sources in the notebook.

### video
**Best for:** Presentations, visual learners, sharing
**Output:** Video file with visuals and narration
**Notes:** Combines audio narration with auto-generated visuals

### reports
**Best for:** Written summaries, documentation, stakeholder updates
**Output:** Structured written report
**Notes:** Organized with sections, headers, and citations from sources

### quizzes
**Best for:** Study prep, knowledge testing, training
**Output:** Interactive quiz with questions and answers
**Notes:** Questions derived from source material with answer explanations

### flashcards
**Best for:** Memorization, spaced repetition, study
**Output:** Question/answer card pairs
**Notes:** Key concepts extracted from sources

### mind maps
**Best for:** Concept relationships, brainstorming, overview
**Output:** Visual concept map
**Notes:** Shows relationships between key ideas across sources

### slides
**Best for:** Presentations, meetings, teaching
**Output:** Slide deck
**Notes:** Auto-structured with key points, one concept per slide

### infographics
**Best for:** Visual summaries, social sharing, quick reference
**Output:** Visual infographic
**Notes:** Data-driven visualization of key points

### data tables
**Best for:** Structured data extraction, comparison, analysis
**Output:** Tabular data
**Notes:** Extracts and structures data points from sources

## Generation Tips

- Audio and video take the longest (1-5 minutes)
- Reports and flashcards are typically fastest (<1 minute)
- All types benefit from well-organized source material
- Multi-source notebooks produce richer outputs
- Poll `studio_status` every 20-30 seconds, never faster than 15 seconds
