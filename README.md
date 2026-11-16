# MathPalette Human Study

A buildless answering website hosted by GitHub Pages, with Supabase storing completed responses.

## Participant flow

The home page shows a short instruction and a compact list of the 15 fixed groups, with progress and clear-group actions. Select a group, enter plain-text answers, and provide an English name after finishing the group. Each question's visible-page time is recorded without displaying a timer. Paper-and-pencil work is welcome; answers require no special syntax.

Every sample occurs once across the groups. Original and Special versions of the same question, including separate Special variants, always belong to different groups. The assignment and order are fixed in docs/groups.json.

Progress and drafts are saved in the same browser. A complete group is submitted to Supabase after the name form. Leaving the question or hiding the tab pauses timing. Previous question and All questions let participants revisit, edit, or clear individual answers. Revisiting a question accumulates time on that question. Clear group deletes only that group's local answers and recorded time, after confirmation. It is available directly on In progress home cards as well as inside a group. Clearing returns to the home page with Open status; timing starts again only when the participant explicitly opens the group.

Completed groups can be withdrawn using the submitting browser. The server removes that group's responses and the browser keeps an editable draft. The participant may then resubmit or clear the group. An uncertain submission stays locked until retry or cancellation confirms its state. Clearing browser storage loses local progress and the ability to withdraw without the organizer.

## Hosting

This repository publishes only docs/ through GitHub Pages. It contains the approved question text, PNGs, and locally hosted KaTeX assets, with no answer keys.

The browser configuration in docs/config.js contains a Supabase project URL and a publishable key. These values are intentionally public. Never put database passwords, secret keys, service-role keys, or volunteer responses in this repository.

## Supabase setup

For a new project, run supabase/setup.sql and then supabase/enable-withdrawal.sql in the project's SQL Editor. For the existing deployed project, run only supabase/enable-withdrawal.sql. It creates:

- human_study_groups: the frozen list of sample IDs for each group and dataset version.
- human_responses: one row per question, with english_name, group_id, sample_id, answer, time_seconds, and version.
- submit_human_group(payload): the private complete-group validator.
- human_submission_receipts: private hashes of random per-submission browser receipts.
- submit_human_group_v2(payload) and withdraw_human_group(payload): atomic submission and withdrawal endpoints.

All three tables enable RLS and deny direct access to public clients. Only the two receipt-protected endpoints are granted to anon/authenticated clients. It validates the complete group, exact sample order, answer lengths, and nonnegative finite question times. Submission accepts identical retries and rejects attempts to overwrite existing answers. Withdrawal deletes only the matching receipt's group. Revoked receipt hashes are retained to stop delayed requests from restoring withdrawn answers. A new submission uses a new random receipt. Existing pre-upgrade submissions can acquire a receipt only by providing the identical complete answers and times already saved in the submitting browser. It exposes no response-reading endpoint.

Names identify respondents; they do not authenticate them. This is a public volunteer study. The administrator views and exports answers through the authenticated Supabase dashboard.

## Export

In Supabase Table Editor, select human_responses and export the data. Alternatively, run this in SQL Editor and export the result:

    select english_name, group_id, sample_id, answer, time_seconds
    from public.human_responses
    order by english_name, group_id, sample_id;

Treat free-text answers as untrusted text when opening CSV files in spreadsheet software. Raw responses should be retained when grading.

## Local preview

From this directory:

    python3 -m http.server 8765 --directory docs

Open http://127.0.0.1:8765. Submitting uses the configured Supabase project, including during local preview. No Python server is deployed.

## Publication

Configure GitHub Settings > Pages > Deploy from a branch > main > /docs. GitHub serves the project at its Pages URL. Relative asset URLs support the repository path.

Do not change the fixed assignment during data collection. A new assignment requires a new dataset version and corresponding server setup.

## Validation limits

Client time measures visible-page duration, not verified thinking time. It includes time spent viewing an enlarged diagram and excludes hidden-tab/loading intervals. Browser crashes may lose the last second of time.

China mainland availability has not been guaranteed. Test both the final Pages URL and an actual Supabase submission from the volunteers' networks before recruitment.

KaTeX 0.19.1 is vendored with its license in docs/vendor/katex/. Question/image source attribution is in ATTRIBUTION.md.
