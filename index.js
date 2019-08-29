/**
 *    Copyright 2019 MetaRing s.r.l.
 * 
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 * 
 *        http://www.apache.org/licenses/LICENSE-2.0
 * 
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */
var fetch = false;
process.argv.forEach(it => it === '--fetch' && (fetch = true));

var align = false;
process.argv.forEach(it => it === '--align' && (align = true));
var nextForcedVersion = null;

const fs = require("fs"),
    git = require("nodegit"),
    maven = require("maven"),
    xml2js = require('xml2js'),
    Enumerable = require('linq'),
    configuration = require('./configuration'),
    http = require('http');
exec = require('child_process').exec;

var directoriesToExclude = configuration.directoriesToExclude || [];
for (var i = 0; i < directoriesToExclude.length; i++) {
    directoriesToExclude[i] = directoriesToExclude[i].trim().toLowerCase().split('\\').join('/');
}

var thisDir = __dirname.toLowerCase().split('\\').join('/');

var localPath = configuration.reposLocation.split('\\').join('/');
!localPath.endsWith('/') && (localPath += '/');
console.log("Project local path is: %s", localPath);

const pomVersionParser = new xml2js.Parser({ attrkey: "version" });

var mavenLogPath = null;
try {
    configuration.mavenLogFileLocation = configuration.mavenLogFileLocation.split(' ').join('').split('\\').join('/');
    !configuration.mavenLogFileLocation.endsWith('/') && (configuration.mavenLogFileLocation += '/');
    var files = fs.readdirSync(configuration.mavenLogFileLocation);
    var logFile = 'version_updater.log'
    if(files && files.length > 0) {
        logFile = files[files.length - 1];
    }
    mavenLogPath = configuration.mavenLogFileLocation + logFile;
    console.log('Maven log file is: ' + mavenLogPath);
} catch (e) {}

var fetchOptions = {
    callbacks: {
        certificateCheck() {
            return 1;
        },
        credentials(url, userName) {
            return git.Cred.sshKeyNew(userName, configuration.publicKeyLocation, configuration.privateKeyLocation, configuration.privateKeyPassphrase || "");
        }
    },
    downloadTags: git.Remote.AUTOTAG_OPTION.DOWNLOAD_TAGS_ALL
};

const author = git.Signature.now(configuration.authorName, configuration.authorEmail);

/***
 * Main functionality
 */
async function main() {
    fetch && console.log("==== FETCH MODE ===");
    align && console.log("==== ALIGN MODE ===");
    await fetchAndUpdate(await getMavenRepos());
    console.log("Maven repo sync end. Bye!");
    process.exit(0);
}

async function fetchAndUpdate(repos) {
    var repos = Enumerable.from(repos);
    nextForcedVersion = !align ? null : repos.orderByDescending(it => it.nextReleaseVersion).first().nextReleaseVersion; 
    nextForcedVersion && console.log('All repos will be updated to version ' + nextForcedVersion);
    var repos = repos.orderBy(it => it.path).toArray();
    repos && repos.length > 0 && console.log('\n');
    var updatedRepos = [];
    for (var i in repos) {
        var repo = repos[i];
        console.log('==> ' + repo.name + ' START <==');
        var repository = null;
        try {
            repository = repo.lastCommitDate ? (await git.Repository.open(repo.path)) : undefined;
            repository && (repository.referencingRepo = repo);
            var oldVersion = repo.pom ? await getPOMVersion(repo.path) : undefined;
            await pullAllChanges(repository, repo);
            oldVersion && console.log('POM Versions: ' + oldVersion + ' -> ' + (await getPOMVersion(repo.path)));
            if (align || await mustBeUpdated(repository, repo)) {
                !fetch && !align && console.log("CHANGES DETECTED Performing release");
                repo.pom = await performRelease(repository, repo);
                !fetch && await sleep(configuration.sleepTime);
            }
        } catch (e) {
            console.log(e);
            console.log('Resetting repo');
            try {
                await resetRepo(repository);
            } catch (e1) {
                console.log("ERROR while resetting repo");
                console.log(e1);
            }
        }
        console.log('==> ' + repo.name + ' END <==\n\n');
    }
    return updatedRepos;
}

function getMavenRepos(currentPath) {
    !currentPath && (currentPath = localPath);
    !currentPath.endsWith('/') && (currentPath += '/');
    return new Promise(function(ok, ko) {
        fs.readdir(currentPath, async function(err, items) {
            if (err) {
                ko(err);
                return;
            }
            var mavenRepos = [];
            for (var i = 0; i < items.length; i++) {
                var path = currentPath + items[i];
                if (items[i].indexOf('.') === 0 || !fs.lstatSync(path).isDirectory() || path.toLowerCase().indexOf(thisDir) !== -1 || path.endsWith('target') || path.endsWith('node_modules') || pathMatchesDirectoryToExclude(path)) {
                    continue;
                }
                !path.endsWith('/') && (path += '/');
                var hasPom = fs.existsSync(path + configuration.fileToStageName);
                var hasGit = fs.existsSync(path + '.git/');
                hasGit && await printGitCloneCommand(path);
                if (hasPom || hasGit) {
                    mavenRepos.push({
                        path,
                        pom: hasPom && fs.readFileSync(path + configuration.fileToStageName, configuration.encoding),
                        lastCommitDate: hasGit && await getLastCommitDate(path),
                        name: hasPom ? await getProjectName(path) : path,
                        nextReleaseVersion : hasPom && align ? await getRemotePOMVersion(path) : null
                    });
                    try {
                        fs.unlinkSync(path + configuration.fileToStageName + '.versionsBackup');
                    } catch (e) {}
                }
                (await getMavenRepos(path)).map(item => item && mavenRepos.push(item));
            }
            ok(mavenRepos);
        });
    });
}

async function printGitCloneCommand(path) {
    var repository = await git.Repository.open(path);
    var config = await repository.config();
    var buf = await config.getStringBuf("remote.origin.url");
    var url = buf.toString();
    var relativePath = '"' + path.split(localPath).join('').trim() + '"';
    console.log("git clone " + url + " " + relativePath);
}

function pathMatchesDirectoryToExclude(p) {
    var path = p.trim().toLowerCase().split('\\').join('/');
    for (var i in directoriesToExclude) {
        if (path.indexOf(directoriesToExclude[i]) !== -1) {
            return true;
        }
    }
    return false;
}

async function mustBeUpdated(repository, repoData) {
    if (repository) {
        var mustBeUpdated = false;
        var walker = git.Revwalk.create(repository);
        walker.pushHead();
        await walker.getCommitsUntil(commit => {
            if (commit.date().getTime() > repoData.lastCommitDate && commit.message().indexOf(configuration.commitMessage) !== -1) {
                mustBeUpdated = true;
            }
            return true;
        });
        if (mustBeUpdated) {
            return true;
        }
    }
    if (repoData.pom && repoData.pom !== fs.readFileSync(repoData.path + configuration.fileToStageName, configuration.encoding)) {
        return true;
    }
    return false;
}

async function getLastCommitDate(repo) {
    var repository = typeof repo !== 'string' ? repo : (await git.Repository.open(repo));
    var head = await git.Reference.nameToId(repository, 'HEAD');
    var lastCommit = await repository.getCommit(head);
    return lastCommit.date().getTime();
}

function getPOMVersion(path) {
    !path.endsWith('/') && (path += '/');
    return new Promise(function(ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + configuration.fileToStageName, configuration.encoding), function(error, pom) {
            if (error) {
                ko(error);
                return;
            }
            ok(pom.project.version[pom.project.version.length - 1]);
        });
    });
}

function getProjectName(path, forURL) {
    !path.endsWith('/') && (path += '/');
    return new Promise(function(ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + configuration.fileToStageName, configuration.encoding), function(error, pom) {
            if (error) {
                ko(error);
                return;
            }
            var groupId = pom.project.groupId[pom.project.groupId.length - 1];
            forURL === true && (groupId = groupId.split('.').join('/'))
            var artifactId = pom.project.artifactId[pom.project.artifactId.length - 1];
            var separator = forURL === true ? "/" : "."
            ok(groupId + separator + artifactId);
        });
    });
}

async function performRelease(repository, repo) {
    if (!repo.pom) {
        return;
    }!fetch && repository && (await commitEdits(repository));
    if (!fetch && repo.pom.indexOf('ossrh') !== -1) {
        var prepareTaskVersions = await getVersionsForPrepareTask(repo.path);
        console.log('Release task versions for: ' + JSON.stringify(prepareTaskVersions));
        await executeMaven(repo.path, 'release:clean');
        await executeMaven(repo.path, 'release:prepare', prepareTaskVersions);
        await executeMaven(repo.path, 'release:perform');
    } else {
        await executeMaven(repo.path, 'install');
    }
    (!fetch && repository) && (await pushAllChanges(repository, prepareTaskVersions.tag, repo));
    return fs.readFileSync(repo.path + configuration.fileToStageName, configuration.encoding);
}

async function executeMaven(repository, task, prepareTaskVersions) {
    const mvn = maven.create({ cwd: repository, quiet: true });
    var parameters = {
        skipTests: true
    };
    mavenLogPath && (parameters.logFile = mavenLogPath);
    prepareTaskVersions && Object.keys(prepareTaskVersions).map(key => parameters[key] = prepareTaskVersions[key]);
    console.log("Running Maven %s task for %s", task, repository);
    await mvn.execute([task], parameters);
}

function checkAndIncrementVersions(version, toCheck, toIncrement) {
    if (version[toCheck] > 9) {
        version[toCheck] = 0;
        version[toIncrement] += 1;
    }
    return version;
}

async function getRemotePOMVersion(path) {
    if (!configuration.mavenCentraURLPath) {
        return await getPOMVersion(path);
    }
    var url = configuration.mavenCentraURLPath.split('{projectName}').join(await getProjectName(path, true));
    return new Promise((ok, ko) => {
        http.get(url, (resp) => {
            var data = '';

            resp.on('data', (chunk) => {
                data += chunk;
            });

            resp.on('end', () => {
                pomVersionParser.parseString(data, function(error, result) {
                    if (error) {
                        ko(error);
                        return;
                    }
                    var oldVersion = result.metadata.versioning[0].release[0];
                    var releaseVersion = increaseVersion(oldVersion).version.join('.');
                    ok(releaseVersion);
                });
            });
        });
    });
}

function increaseVersion(oldVersion) {
    var releaseVersion = oldVersion.split('-SNAPSHOT').join('').split('-RELEASE').join();
    var version = releaseVersion.split('.');
    version[0] = parseInt(version[0]);
    version[1] = parseInt(version[1]);
    version[2] = parseInt(version[2]) + 1;
    version = checkAndIncrementVersions(version, 2, 1);
    version = checkAndIncrementVersions(version, 1, 0);
    return {
        releaseVersion,
        version
    }
}

async function getVersionsForPrepareTask(path) {
    var oldVersion = nextForcedVersion || await getRemotePOMVersion(path);
    var versionData = increaseVersion(oldVersion);
    var releaseVersion = versionData.releaseVersion;
    var version = versionData.version;
    var tag = 'v' + releaseVersion;
    var developmentVersion = version[0] + '.' + version[1] + '.' + version[2] + '-SNAPSHOT';
    return {
        releaseVersion,
        tag,
        developmentVersion
    };
}

async function resetRepo(repository) {
    if (!repository) {
        return;
    }
    (await git.Tag.list(repository)).map(async tag => await git.Tag.delete(repository, tag));
    await git.Reset.reset(repository, await repository.getHeadCommit(), git.Reset.TYPE.HARD);
    await repository.fetchAll(fetchOptions);
    await git.Reset.reset(repository, await repository.getBranchCommit(configuration.originBranchName), git.Reset.TYPE.HARD);
    (await git.Tag.list(repository)).map(async tag => await git.Tag.delete(repository, tag));
    repository.referencingRepo.lastCommit = await repository.getHeadCommit();
}

async function pullAllChanges(repository, repo) {
    await resetRepo(repository);
    if (repo.pom) {
        await executeMaven(repo.path, 'clean');
        await executeMaven(repo.path, 'versions:use-releases');
        await executeMaven(repo.path, 'versions:use-latest-releases');
    }
}

async function getDiffFiles(repository) {
    const diff = await git.Diff.indexToWorkdir(repository, null, {
        flags: git.Diff.OPTION.SHOW_UNTRACKED_CONTENT | git.Diff.OPTION.RECURSE_UNTRACKED_DIRS
    });
    const patches = await diff.patches();
    return patches.map(patch => patch.newFile().path());
}

async function commitEdits(repository, tagVersion) {
    console.log("Committing edits in " + repository.referencingRepo.path);
    var diffs = await getDiffFiles(repository);
    if (!diffs || diffs.length === 0) {
        console.log('No files to commit!');
        return;
    }
    var openIndex = await repository.refreshIndex();
    await openIndex.addAll();
    await openIndex.write();
    var oid = await openIndex.writeTreeTo(repository);
    await repository.createCommit('HEAD', author, author, configuration.pushMessage + (tagVersion || ''), oid, [await repository.getHeadCommit()]);
    var commit = await repository.getHeadCommit();
    return commit;
}

async function pushAllChanges(repository, tagVersion, repo, forceMode) {
    console.log("Pushing the new tag release " + tagVersion + " for repository " + repo.name);
    await repository.fetchAll(fetchOptions);
    await git.Reset.reset(repository, await repository.getBranchCommit(configuration.originBranchName), git.Reset.TYPE.MIXED);
    var headCommit = await commitEdits(repository, tagVersion);
    await git.Tag.create(repository, tagVersion, headCommit, author, configuration.pushMessage + tagVersion, 1);
    try {
        var remoteResult = await repository.getRemote('origin');
        await remoteResult.push([(forceMode === true ? '+' : '') + configuration.branchReferenceName, (forceMode === true ? '+' : '') + configuration.tagReferenceName + tagVersion], fetchOptions);
    } catch (e) {
        forceMode !== true && console.log('Push failed, trying again in force mode...');
        forceMode === true && console.log(e);
        forceMode !== true && await pushAllChanges(repository, tagVersion, repo, true);
    }
}

async function sleep(ms) {
    console.log('Sleeping for ' + ms + ' msec...');
    await new Promise(ok => setTimeout(ok, ms));
    console.log('Woke Up!');
}
main().catch(console.log);