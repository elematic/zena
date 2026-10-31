#!/usr/bin/env python3
"""Measure how agent sessions and their pull requests went over a period.

The retro skill (.claude/skills/retro) runs this each week and records the
summary, so the numbers must be computed the same way every time; change
a measure only together with a note in docs/agents/README.md, "Measures".

Sources:
- Claude Code transcripts (one JSONL file per session) in --transcripts,
  default ~/.claude/projects/-home-dev-work, the directory of sessions
  started in /home/dev/work;
- the repository's pull requests, CI runs and review comments, through
  `gh` (skip with --no-github);
- with --lint, `zena lint` over the .zena files under packages/ added in
  the period (needs ./target/release/zena-cli).

It prints a Markdown summary and writes the messages behind each count
(relays, corrections, review comments) to --out as signals.json, for the
retro to read and cluster.

Run from the repository root:
  python3 scripts/agent-signals.py --since 2026-10-24 [--until 2026-10-31] \
      [--out .zena/agent-signals] [--no-github] [--lint]
"""

import argparse
import collections
import glob
import json
import os
import re
import statistics
import subprocess
from datetime import datetime, timedelta, timezone

AGENT = 'elematic-bot'

# A message that passes on GitHub state the session could have read itself.
RELAY = re.compile(
    r'#\d+.{0,40}\b(is|are|was|got|been)\s+(merged|landed|closed)'
    r'|\b(needs?|need) a rebase\b|\bfailed (the )?(format|formatting|ci|check)'
    r'|\bci (failed|is red)\b',
    re.I,
)
# A message that corrects or redirects the agent. Deliberately broad: the
# retro reads the matches and discards the ones that are not corrections.
CORRECTION = re.compile(
    r"\b(don'?t|do not|didn'?t you|why (did|didn'?t|are|is)|instead of|"
    r"should(n'?t)? (be|use|have)|please (use|fix|don'?t|remove|run)|again\b|"
    r"i (told|said|asked)|remember\b|we (don'?t|shouldn'?t|never)|"
    r"not what i|that'?s wrong|isn'?t a thing)",
    re.I,
)
FAILURES = {
    'zsh glob (no matches found)': re.compile(r'no matches found:'),
    'command not found': re.compile(r'command not found'),
    'prettier reported unformatted files': re.compile(
        r'Code style issues found|not formatted \(npm run check'),
    'git push rejected or unauthenticated': re.compile(
        r'\[rejected\]|could not read Username|SSL certificate problem'),
    'zir unsupported': re.compile(r'zir unsupported'),
}
EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}


def parse_time(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def message_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(
        part.get('text', '') for part in content or []
        if isinstance(part, dict) and part.get('type') == 'text')


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(
            part.get('text', '') if isinstance(part, dict) else str(part)
            for part in content)
    return str(content)


def read_transcripts(directory, since, until):
    """Per-session counts and the human messages of the period."""
    sessions = []
    messages = []
    failures = collections.Counter()
    for path in sorted(glob.glob(os.path.join(directory, '*.jsonl'))):
        if os.path.getsize(path) == 0:
            continue
        session = os.path.basename(path)[:-len('.jsonl')]
        first = None
        api_calls = output = context = 0
        calls_before_edit = None
        tool_calls = 0
        seen = set()
        bash_ids = set()
        in_period = False
        with open(path) as lines:
            for line in lines:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                stamp = event.get('timestamp')
                if not stamp:
                    continue
                when = parse_time(stamp)
                first = first or when
                if not since <= when < until:
                    continue
                in_period = True
                kind = event.get('type')
                message = event.get('message') or {}
                if kind == 'assistant' and message.get('model') != '<synthetic>':
                    if message.get('id') not in seen:
                        seen.add(message.get('id'))
                        usage = message.get('usage') or {}
                        api_calls += 1
                        output += usage.get('output_tokens') or 0
                        context += sum(
                            usage.get(key) or 0 for key in (
                                'input_tokens', 'cache_read_input_tokens',
                                'cache_creation_input_tokens'))
                    for part in message.get('content') or []:
                        if part.get('type') != 'tool_use':
                            continue
                        if part.get('name') in EDIT_TOOLS and calls_before_edit is None:
                            calls_before_edit = tool_calls
                        if part.get('name') == 'Bash':
                            bash_ids.add(part.get('id'))
                        tool_calls += 1
                elif kind == 'user':
                    content = message.get('content')
                    if isinstance(content, list):
                        for part in content:
                            if (isinstance(part, dict)
                                    and part.get('type') == 'tool_result'
                                    and part.get('tool_use_id') in bash_ids):
                                text = result_text(part.get('content'))
                                for name, pattern in FAILURES.items():
                                    if pattern.search(text):
                                        failures[name] += 1
                    origin = event.get('origin') or {}
                    if (origin.get('kind') == 'human' and not event.get('isMeta')
                            and not event.get('isCompactSummary')
                            and not event.get('toolUseResult')):
                        text = message_text(content).strip()
                        if text:
                            messages.append({
                                'session': session, 'time': stamp, 'text': text})
        if not in_period:
            continue
        sessions.append({
            'session': session,
            'started_in_period': first is not None and first >= since,
            'api_calls': api_calls,
            'output_tokens': output,
            'context_tokens': context,
            'tool_calls': tool_calls,
            'tool_calls_before_first_edit': calls_before_edit,
        })
    return sessions, messages, failures


def gh(*args):
    result = subprocess.run(['gh', *args], capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def read_github(since, until):
    """First-run CI results and human review comments of the period's PRs."""
    day = since.date().isoformat()
    repo = gh('repo', 'view', '--json', 'nameWithOwner')['nameWithOwner']
    prs = gh('pr', 'list', '--state', 'all', '--limit', '500', '--search',
             f'created:>={day}', '--json',
             'number,title,author,createdAt,state,headRefName')
    prs = [pr for pr in prs if since <= parse_time(pr['createdAt']) < until]
    runs = gh('run', 'list', '--workflow', 'test.yml', '--event', 'pull_request',
              '--limit', '1000', '--created', f'>={day}', '--json',
              'databaseId,headBranch,conclusion,createdAt,status')
    first_runs = {}
    for run in sorted(runs, key=lambda run: run['createdAt']):
        if run['status'] == 'completed' and run['conclusion'] != 'cancelled':
            first_runs.setdefault(run['headBranch'], run)
    first = []
    for pr in prs:
        run = first_runs.get(pr['headRefName'])
        if run is None:
            continue
        failed_jobs = []
        if run['conclusion'] != 'success':
            jobs = gh('run', 'view', str(run['databaseId']), '--json', 'jobs')['jobs']
            failed_jobs = [job['name'] for job in jobs
                           if job['conclusion'] not in ('success', 'skipped')]
        first.append({'pr': pr['number'], 'conclusion': run['conclusion'],
                      'failed_jobs': failed_jobs})
    comments = []
    for pr in prs:
        n = pr['number']
        for endpoint, kind in ((f'repos/{repo}/pulls/{n}/comments', 'inline'),
                               (f'repos/{repo}/pulls/{n}/reviews', 'review'),
                               (f'repos/{repo}/issues/{n}/comments', 'comment')):
            for item in gh('api', endpoint, '--paginate') or []:
                login = (item.get('user') or {}).get('login', '')
                body = (item.get('body') or '').strip()
                if login == AGENT or login.endswith('[bot]') or not body:
                    continue
                comments.append({'pr': n, 'kind': kind, 'path': item.get('path'),
                                 'author': login, 'text': body})
    return prs, first, comments


def lint_new_files(since, until):
    """zena lint findings per rule in .zena files added under packages/."""
    added = subprocess.run(
        ['git', 'log', f'--since={since.isoformat()}', f'--until={until.isoformat()}',
         '--diff-filter=A', '--name-only', '--format=', 'origin/main', '--',
         'packages/*.zena'],
        capture_output=True, text=True, check=True).stdout.split()
    files = sorted({f for f in added if os.path.exists(f)
                    and '/test-files/' not in f})
    if not files:
        return 0, collections.Counter()
    out = subprocess.run(['./target/release/zena-cli', 'lint', *files],
                         capture_output=True, text=True).stdout
    rules = collections.Counter(re.findall(r'\[([a-z-]+)\]$', out, re.M))
    return len(files), rules


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--since', required=True, help='YYYY-MM-DD (UTC)')
    parser.add_argument('--until', help='YYYY-MM-DD (UTC), exclusive; default now')
    parser.add_argument('--transcripts', default=os.path.expanduser(
        '~/.claude/projects/-home-dev-work'))
    parser.add_argument('--out', default='.zena/agent-signals')
    parser.add_argument('--no-github', action='store_true')
    parser.add_argument('--lint', action='store_true')
    args = parser.parse_args()
    since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
    until = (datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc)
             if args.until else datetime.now(timezone.utc) + timedelta(seconds=1))

    sessions, messages, failures = read_transcripts(args.transcripts, since, until)
    relays = [m for m in messages if RELAY.search(m['text'])]
    corrections = [m for m in messages
                   if CORRECTION.search(m['text']) and m not in relays]
    calls = sum(s['api_calls'] for s in sessions)
    orientation = [s['tool_calls_before_first_edit'] for s in sessions
                   if s['started_in_period']
                   and s['tool_calls_before_first_edit'] is not None]

    rows = [
        ('sessions', len(sessions)),
        ('human messages', len(messages)),
        ('relay messages (GitHub state passed on by hand)',
         f'{len(relays)} ({len(relays) / max(len(messages), 1):.0%})'),
        ('correction candidates (read them; the pattern is broad)', len(corrections)),
        ('API calls', calls),
        ('mean context per API call (tokens)',
         round(sum(s['context_tokens'] for s in sessions) / max(calls, 1))),
        ('output tokens', sum(s['output_tokens'] for s in sessions)),
        ('median tool calls before first edit (new sessions)',
         statistics.median(orientation) if orientation else '-'),
    ]
    rows += [(f'failed Bash calls: {name}', count) for name, count in failures.most_common()]

    details = {'since': args.since, 'until': args.until, 'relays': relays,
               'corrections': corrections, 'sessions': sessions}
    if not args.no_github:
        prs, first, comments = read_github(since, until)
        failed = [run for run in first if run['conclusion'] != 'success']
        jobs = collections.Counter(job for run in failed for job in run['failed_jobs'])
        rows += [
            ('PRs opened', len(prs)),
            ('PRs whose first CI run failed',
             f'{len(failed)} of {len(first)}'
             + (f" ({', '.join(f'{job} {n}' for job, n in jobs.most_common())})"
                if jobs else '')),
            ('human review comments', f'{len(comments)} on '
             f"{len({c['pr'] for c in comments})} PRs"),
        ]
        details.update({'first_ci_runs': first, 'review_comments': comments})
    if args.lint:
        count, rules = lint_new_files(since, until)
        rows.append(('zena lint findings in .zena files added under packages/',
                     f'{sum(rules.values())} in {count} files'
                     + (f" ({', '.join(f'{r} {n}' for r, n in rules.most_common(5))})"
                        if rules else '')))
        details['lint_rules'] = dict(rules)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'signals.json'), 'w') as out:
        json.dump(details, out, indent=1)
    print(f'## Agent signals, {args.since} to {args.until or "now"}\n')
    print('| measure | value |\n| --- | --- |')
    for name, value in rows:
        print(f'| {name} | {value} |')
    print(f"\nMessages and comments: {os.path.join(args.out, 'signals.json')}")


if __name__ == '__main__':
    main()
