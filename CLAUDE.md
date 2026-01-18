# AI rules and hints

## Cross-repo, shared instructions

### General
- prefer to find a way to fix issue instead of rollback to previous solution

### General code style
- if u add comments into code - write it in english
- dont add obvious comments in code
- better to bind comments to vars, functions via JSDoc
- use meaningful and understandable names for functions, variables
- function names must start with verb (if u return something new - "create", if u search or extract something and return - "get", if u modify something - "add", "update", etc. if u filter something - "getFilteredSomething")
- usually functions operates with some entities or domain - noun, so it should be added to name.
- variables usually contains some entity or array of something that may be named via noun, but sometimes adjectives must be used to clarify, so use adjective+noun
- prefer .toString() instead of String()
- prefer do not inline types, if they contain more than 2 props, create type or interface for it
- prefer to search exist type in a repo, guessing its name by var/function name and patterns of use in rest of code.
- prefer put types to separate files. exception - react component props. if u create new type and it is small, most probably it is local and cannot be re-used - leave it in same file.
- after u finish work - check all edited files - that all good there, and that there no unused imports, vars (but leave unused vars in destructuting objects with creation of new object with rest parameters - special case)
- if user refers some code in a message u must find it and read source.
- for operations on files, dirs, search keyword, git prefer to use commands that is already allowed to u in .claude/settings.local.json
- when searching files, separate pattern (**/*.ts) and path (local/path/to/dir)
- if user made some changes in a code and tell u about it, ask permission additionally if u r going to edit that code.
- use camelCase for names, file, dir names, even for constants. enums with Capitalized first letter.
- dont use UPPER_CASE for constants in code (use camelCase). UPPER_CASE allowed only for shell-variables and global vars that is set during code build
- use "is" prefix for vars with boolean value (isDone), but dont add such prefix to DB schema props.
- prefer to use "check" prefix for func that return booleans, e.g. "checkIsSomethingTrue"
- prefer use .ts (typescript) when possible
- use yarn berry built-in `yarn patch` instead of `npx patch-package`
- dont add inline arrow-functions `() => something` to component props for event handlers
- dont use index.ts to re-export all entities from folder (to make it easier to navigate, refactor and improve lazy loading)
- When modifying npm scripts that use environment variables, trace the FULL call chain to verify env vars are passed correctly at each step
- Before saying "done", verify the complete flow: check all scripts in the chain, not just the entry point
- always check all call chain for possible errors, in a code, in a scripts, commands
- do not roll back changes, try to see things through to the end

### TypeScript, eslint rules
- do NOT use `@ts-nocheck` or `@ts-ignore`
- do NOT use `@ts-expect-error`, try to ultrathink and fix problematic peace of code with maximum understanding of context.
- do not use `unknown` type - search for proper types in the codebase
- never remove comments, especially TODO/FIXME comments
- **CRITICAL**: Before using any function/hook/utility, ALWAYS search for its type signature first! Use Grep to find the function definition and understand what parameters it expects. This prevents incorrect usage.
- if u not sure how to fix ts, eslint error, error prompt from user - search web for hits
- find and use existing types in repo first. do not create new types unnecessarily
- if u r converting not typed code to TS - u will need to look for suitable types based on the names of the vars and functions
- prefer do not use type casting for vars (someVar as string), need to extend context, figure out where to update type better and make them compatible between each other. Except for typed arrays and enums (e.g. when array typed as string[] and we check arr.includes(someEnumValue as string))
- prefer "Conditional return type с generic" instead of "overloading of functions"
- move types that shared between few files to separate file (types.ts) on a highest dir level it is used or in `/types/{domain/entity/category}.ts` file if this type uses broadly

### Git commits
- dont run git with -C argument
- dont run with --no-verify, always try to fix all errors that prevet u to make commit. even pre-existing errors
- dont reset changes, if u r think that u should start over - ask user what to do.
- do not add "Generated with [Claude Code]" to commit messages
- do not add "Co-Authored-By: Claude" to commit messages
- always include yarn.lock in commit when package.json dependencies changed
- **Commit message title**: describe the problem/bug that was fixed, not implementation details
  - BAD: `fix(Swiper): single source of truth for sharedActiveIndex` (implementation detail)
  - GOOD: `fix(Swiper): eliminate flash when swiping during animation` (actual problem solved)
  - Title answers "what problem does this commit solve?" not "what code changed?"
  - Implementation details (root cause, solution approach) go in commit body

### JSDoc rules
- use JSDoc for complex and not obvious logic that user describes to u
- for enums use `@name EnumName`, `@description` tags
- if u change logic in code and there is related JSDoc - do not forget to update it

Example:
```ts
/**
 * @name SwiperPhases
 * @description Description with nuances of logic
 */
export enum SwiperPhases {
  animateStart = 'animateStart',
  animateContinue = 'animateContinue',
}
```
