import assert from "assert"
import { differenceInMilliseconds } from "date-fns"
import fs from "fs"
import ld from "lodash"
import { MatrixClient } from "matrix-bot-sdk"
import path from "path"
import { promisify } from "util"

import { ShellExecutor } from "./executor"
import { Logger } from "./logger"
import { ApiTask, CommandOutput, State } from "./types"

const fsExists = promisify(fs.exists)

export const getLines = function (str: string) {
  return str
    .split("\n")
    .map(function (line) {
      return line.trim()
    })
    .filter(function (line) {
      return !!line
    })
}

export const getCommand = function (
  commandLine: string,
  { baseEnv }: { baseEnv: Record<string, string> },
) {
  const parts = commandLine.split(" ").filter(function (value) {
    return !!value
  })

  const [envArgs, command] = ld.partition(parts, function (value) {
    return value.match(/^[A-Za-z_]+=/)
  })

  const env: Record<string, string> = baseEnv
  for (const rawValue of envArgs) {
    const matches = rawValue.match(/^([A-Za-z_]+)=(.*)/)
    assert(matches)

    const [, name, value] = matches
    assert(name)
    assert(value !== undefined && value !== null)

    env[name] = value
  }

  const [execPath, ...args] = command

  return { execPath, args, env }
}

export const redactSecrets = function (str: string, secrets: string[] = []) {
  for (const secret of secrets) {
    if (!secret) {
      continue
    }
    str = str.replace(secret, "{SECRET}")
  }
  return str
}

export const displayCommand = function ({
  execPath,
  args,
  secretsToHide,
}: {
  execPath: string
  args: string[]
  secretsToHide: string[]
}) {
  return redactSecrets(`${execPath} ${args.join(" ")}`, secretsToHide)
}

export const millisecondsDelay = function (milliseconds: number) {
  return new Promise<void>(function (resolve) {
    setTimeout(resolve, milliseconds)
  })
}

export const ensureDir = function (dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

export const removeDir = function (dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmdirSync(dir, { recursive: true })
  }
  return dir
}

export const initDatabaseDir = function (dir: string) {
  dir = ensureDir(dir)
  const lockPath = path.join(dir, "LOCK")
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath)
  }
  return dir
}

export const getDeploymentLogsMessage = function (
  deployment: State["deployment"],
) {
  if (deployment === undefined) {
    return ""
  }

  return `The logs for this command should be available on Grafana for the data source \`loki.${deployment.environment}\` and query \`{container=~"${deployment.container}"}\``
}

export class Retry {
  context: string
  motive: string
  error: string

  constructor(options: {
    context: "compilation error"
    motive: string
    error: string
  }) {
    this.context = options.context
    this.motive = options.motive
    this.error = options.error
  }
}

export const displayError = function (e: Error) {
  return `${e.toString()}\n${e.stack}`
}

export const getSendMatrixResult = function (
  matrix: MatrixClient,
  logger: Logger,
  {
    matrixRoom,
    handleId,
    commandDisplay,
  }: Pick<ApiTask, "matrixRoom" | "handleId" | "commandDisplay">,
) {
  return async function (message: CommandOutput) {
    try {
      const fileName = `${handleId}-log.txt`
      const buf = message instanceof Error ? displayError(message) : message
      const messagePrefix = `Handle ID ${handleId} has finished.`

      const lineCount = (buf.match(/\n/g) || "").length + 1
      if (lineCount < 128) {
        await matrix.sendHtmlText(
          matrixRoom,
          `${messagePrefix} Results will be displayed inline for <code>${escapeHtml(
            commandDisplay,
          )}</code>\n<hr>${escapeHtml(buf)}`,
        )
        return
      }

      const url = await matrix.uploadContent(
        Buffer.from(message instanceof Error ? displayError(message) : message),
        "text/plain",
        fileName,
      )
      await matrix.sendText(
        matrixRoom,
        `${messagePrefix} Results were uploaded as ${fileName} for ${commandDisplay}.`,
      )
      await matrix.sendMessage(matrixRoom, {
        msgtype: "m.file",
        body: fileName,
        url,
      })
    } catch (error) {
      logger.fatal(
        error?.body?.error,
        "Caught error when sending matrix message",
      )
    }
  }
}

export const displayDuration = function (start: Date, finish: Date) {
  const delta = Math.abs(differenceInMilliseconds(finish, start))

  const days = Math.floor(delta / 1000 / 60 / 60 / 24)
  const hours = Math.floor((delta / 1000 / 60 / 60) % 24)
  const minutes = Math.floor((delta / 1000 / 60) % 60)
  const seconds = Math.floor((delta / 1000) % 60)

  const milliseconds =
    delta -
    days * 24 * 60 * 60 * 1000 -
    hours * 60 * 60 * 1000 -
    minutes * 60 * 1000 -
    seconds * 1000

  let buf = ""
  const separator = ", "
  for (const [name, value] of Object.entries({
    days,
    hours,
    minutes,
    seconds,
    milliseconds,
  })) {
    if (!value) {
      continue
    }
    buf = `${buf}${separator}${value} ${name}`
  }

  return buf.slice(separator.length)
}

const escapeHtml = function (str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

const websocketPrefixes = ["wss://", "ws://"]
const urlArg = "--url="
const addressPrefixes = websocketPrefixes.concat(
  websocketPrefixes.map(function (prefix) {
    return `${urlArg}${prefix}`
  }),
)
export const getParsedArgs = function (
  nodesAddresses: State["nodesAddresses"],
  args: string[],
) {
  const nodeOptionsDisplay = `Available names are: ${Object.keys(
    nodesAddresses,
  ).join(", ")}.`

  const parsedArgs = []
  toNextArg: for (const arg of args) {
    for (const prefix of addressPrefixes) {
      if (!arg.startsWith(prefix)) {
        continue
      }

      const node = arg.slice(prefix.length)
      if (!node) {
        return `Must specify one address in the form \`${prefix}name\`. ${nodeOptionsDisplay}`
      }

      const nodeAddress = nodesAddresses[node]
      if (!nodeAddress) {
        return `Nodes are referred to by name. No node named "${node}" is available. ${nodeOptionsDisplay}`
      }

      parsedArgs.push(
        arg.startsWith(urlArg) ? `${urlArg}${nodeAddress}` : nodeAddress,
      )
      continue toNextArg
    }

    parsedArgs.push(arg)
  }

  return parsedArgs
}

const walkDirs: (dir: string) => AsyncGenerator<string> = async function* (
  dir,
) {
  for await (const d of await fs.promises.opendir(dir)) {
    if (!d.isDirectory()) {
      continue
    }

    const fullPath = path.join(dir, d.name)
    yield fullPath

    yield* walkDirs(fullPath)
  }
}

export const cleanupProjects = async function (
  executor: ShellExecutor,
  projectsRoot: string,
  {
    includeDirs,
    excludeDirs = [],
  }: { includeDirs?: string[]; excludeDirs?: string[] } = {},
) {
  const results: CommandOutput[] = []

  toNextProject: for await (const p of walkDirs(projectsRoot)) {
    if (!(await fsExists(path.join(p, ".git")))) {
      continue
    }

    if (includeDirs !== undefined) {
      if (
        includeDirs.filter(function (includeDir) {
          return isDirectoryOrSubdirectory(includeDir, p)
        }).length === 0
      ) {
        continue toNextProject
      }
    }

    for (const excludeDir of excludeDirs) {
      if (isDirectoryOrSubdirectory(excludeDir, p)) {
        continue toNextProject
      }
    }

    const projectDir = path.dirname(p)

    // The project's directory might have been deleted as a result of a previous
    // cleanup step
    if (!(await fsExists(projectDir))) {
      continue
    }

    try {
      results.push(
        await executor(
          "sh",
          ["-c", "git add . && git reset --hard && git clean -xdf"],
          { options: { cwd: projectDir } },
        ),
      )
    } catch (error) {
      results.push(error)
    }
  }

  return results
}

const isDirectoryOrSubdirectory = function (parent: string, child: string) {
  if (arePathsEqual(parent, child)) {
    return true
  }

  const relativePath = path.relative(parent, child)
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return true
  }

  return false
}

const arePathsEqual = function (a: string, b: string) {
  return a === b || normalizePath(a) === normalizePath(b)
}

const normalizePath = function normalizePath(v: string) {
  for (const [pattern, replacement] of [
    [/\\/g, "/"],
    [/(\w):/, "/$1"],
    [/(\w+)\/\.\.\/?/g, ""],
    [/^\.\//, ""],
    [/\/\.\//, "/"],
    [/\/\.$/, ""],
    [/\/$/, ""],
  ] as const) {
    while (pattern.test(v)) {
      v = v.replace(pattern, replacement)
    }
  }

  return v
}

export const freeDiskSpace = async function ({
  cwd,
  projectsRoot,
  logger,
  executor,
  error,
  retries,
  commandDisplayed,
}: {
  cwd: string | null
  projectsRoot: string
  logger: Logger
  executor: ShellExecutor
  error: string
  retries: Retry[]
  commandDisplayed: string | null
}): Promise<Retry | undefined> {
  if (cwd !== null && !cwd.startsWith(projectsRoot)) {
    logger.fatal(
      `Unable to recover from lack of disk space because the directory "${cwd}" is not included in the projects root "${projectsRoot}"`,
    )
    return
  }

  const cleanupMotiveForOtherDirectories = cwd
    ? `Cleanup for disk space for excluding "${cwd}" from "${projectsRoot}" root`
    : "Cleaning up all directories since no specific directory was filtered"
  const cleanupMotiveForThisDirectory = cwd
    ? `Cleanup for disk space for including only "${cwd}" from "${projectsRoot}" root`
    : "Cleaning up all directories since no specific directory was filtered"

  const hasAttemptedCleanupForOtherDirectories =
    retries.find(function ({ motive }) {
      return motive === cleanupMotiveForOtherDirectories
    }) === undefined
  const hasAttemptedCleanupForThisDirectory = cwd
    ? retries.find(function ({ motive }) {
        return motive === cleanupMotiveForThisDirectory
      }) === undefined
    : true

  if (
    hasAttemptedCleanupForOtherDirectories &&
    hasAttemptedCleanupForThisDirectory
  ) {
    logger.fatal(
      { retries },
      "No approaches left to try out for recovering from disk space failure",
    )
  } else {
    if (commandDisplayed) {
      logger.info(
        `Running disk cleanup before retrying the command "${commandDisplayed}" in "${cwd}" due to lack of disk space in the host.`,
      )
    }

    if (!hasAttemptedCleanupForOtherDirectories) {
      const otherDirectoriesResults = await cleanupProjects(
        executor,
        projectsRoot,
        { excludeDirs: cwd ? [cwd] : [] },
      )
      // Relevant check because the current project might be
      // the only one we have available in this application.
      if (otherDirectoriesResults.length) {
        return new Retry({
          context: "compilation error",
          motive: cleanupMotiveForOtherDirectories,
          error,
        })
      }
    }

    if (cwd) {
      const directoryResults = await cleanupProjects(executor, projectsRoot, {
        includeDirs: [cwd],
      })
      if (directoryResults.length) {
        return new Retry({
          context: "compilation error",
          motive: cleanupMotiveForThisDirectory,
          error,
        })
      } else {
        logger.fatal(
          `Expected to have found a project for "${cwd}" during cleanup for disk space`,
        )
      }
    }
  }
}
