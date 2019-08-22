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

var force = false;
process.argv.forEach(it => it === '--force' && (force = true));

var fetch = false;
process.argv.forEach(it => it === '--fetch' && (fetch = true));

const fs = require("fs"),
    git = require("nodegit"),
    maven = require("maven"),
    xml2js = require('xml2js'),
    Enumerable = require('linq'),
    configuration = require('./configuration');

var directoriesToExclude = configuration.directoriesToExclude || [];
for (var i = 0; i < directoriesToExclude.length; i++) {
    directoriesToExclude[i] = directoriesToExclude[i].trim().toLowerCase().split('\\').join('/');
}

var thisDir = __dirname.toLowerCase().split('\\').join('/');

var localPath = configuration.reposLocation.split('\\').join('/');
!localPath.endsWith('/') && (localPath += '/');
console.log("Project local path is: %s", localPath);

const pomVersionParser = new xml2js.Parser({ attrkey: "version" });

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
    force && console.log("==== FORCE MODE ===");
    fetch && console.log("==== FETCH MODE ===");
    await fetchAndUpdate(await getMavenRepos());
    console.log("Maven repo sync end. Bye!");
    process.exit(0);
}

async function fetchAndUpdate(repos) {
    var repos = Enumerable.from(repos).orderBy(it => it.path).toArray();
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
            if (force || (await mustBeUpdated(repository, repo))) {
                !force && !fetch && console.log("CHANGES DETECTED Performing release");
                repo.pom = await performRelease(repository, repo);
            }
        } catch (e) {
            console.log(e);
            console.log('Resetting repo');
            try {
                await resetRepo(repository);
            } catch(e1) {
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
                        name: hasPom ? await getProjectName(path) : path
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

function getProjectName(path) {
    !path.endsWith('/') && (path += '/');
    return new Promise(function(ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + configuration.fileToStageName, configuration.encoding), function(error, pom) {
            if (error) {
                ko(error);
                return;
            }
            ok(pom.project.groupId[pom.project.groupId.length - 1] + "." + pom.project.artifactId[pom.project.artifactId.length - 1]);
        });
    });
}

async function performRelease(repository, repo) {
    if (!repo.pom) {
        return;
    }
    !fetch && repository && (await commitEdits(repository));
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
    prepareTaskVersions && Object.keys(prepareTaskVersions).map(key => parameters[key] = prepareTaskVersions[key]);
    console.log("Running Maven %s task for %s", task, repository);
    await mvn.execute([task], parameters);
}

function checkAndIncrementVersions(version, toCheck, toIncrement, inc) {
    if (version[toCheck] > 9) {
        version[toCheck] = inc && inc > 0 ? inc - 1 : 0;
        version[toIncrement] += 1;
    }
    return version;
}

async function getVersionsForPrepareTask(path) {
    var inc = force ? 2 : 0;
    var oldVersion = await getPOMVersion(path);
    var releaseVersion = oldVersion.split('-SNAPSHOT').join('').split('-RELEASE').join();
    var version = releaseVersion.split('.');
    version[0] = parseInt(version[0]);
    version[1] = parseInt(version[1]);
    version[2] = parseInt(version[2]) + (inc + 1);
    version = checkAndIncrementVersions(version, 2, 1, inc);
    version = checkAndIncrementVersions(version, 1, 0, 0);

    if (force) {
        releaseVersion = version[0] + '.' + version[1] + '.' + version[2];
        version[2] = parseInt(version[2]) + 1;
        version = checkAndIncrementVersions(version, 2, 1);
        version = checkAndIncrementVersions(version, 1, 0);
    }

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
    var diffFiles = await getDiffFiles(repository);
    if(!diffFiles || diffFiles.length === 0) {
        console.log('No files to commit!');
        return;
    }
    var openIndex = await repository.refreshIndex();
    diffFiles.map(async path => {
        console.log('Adding ' + path);
        await openIndex.addByPath(path);
    });
    await openIndex.write();
    var oid = await openIndex.writeTree();
    return await repository.createCommit('HEAD', author, author, configuration.pushMessage + (tagVersion || ''), oid, [repository.referencingRepo.lastCommit]);
}

async function pushAllChanges(repository, tagVersion, repo, forceMode) {
    console.log("Pushing the new tag release " + tagVersion + " for repository " + repo.name);
    await git.Reset.reset(repository, repo.lastCommit, git.Reset.TYPE.MIXED);
    await commitEdits(repository, tagVersion);
    await git.Tag.create(repository, tagVersion, await repository.getHeadCommit(), author, configuration.pushMessage + tagVersion, 1);
    try {
        var remoteResult = await repository.getRemote('origin');
        await remoteResult.push([(forceMode === true ? '+' : '') + configuration.branchReferenceName, (force === true ? '+' : '') + configuration.tagReferenceName + tagVersion], fetchOptions);
    } catch (e) {
        forceMode !== true && console.log('Push failed, trying again in force mode...');
        forceMode === true && console.log(e);
        forceMode !== true && await pushAllChanges(repository, tagVersion, repo, true);
    }
}
main().catch(console.log);