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
for(var i = 0; i < directoriesToExclude.length; i++) {
    directoriesToExclude[i] = directoriesToExclude[i].trim().toLowerCase().split('\\').join('/');
}

var thisDir = __dirname.toLowerCase().split('\\').join('/');

// Ensure that the `tmp` directory is local to this file and not the CWD.
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
            console.log('Url: %s, User Name: %s', url, userName);
            return git.Cred.sshKeyNew(userName, configuration.publicKeyLocation, configuration.privateKeyLocation, configuration.privateKeyPassphrase || "");
        },
        transferProgress(info) {
            return console.log("Transfering ....... " + info.receivedObjects() + ' / ' + info.totalObjects());
        }
    }
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
    var updatedRepos = [];
    for (var i in repos) {
        var repo = repos[i];
        try {
            var repository = repo.lastCommitDate ? (await git.Repository.open(repo.path)) : undefined;
            console.log('POM Version ' + (await getPOMVersion(repo.path)) + ' for repo ' + repo.name);
            await pullAllChanges(repository, repo);
            console.log('POM Version ' + (await getPOMVersion(repo.path)) + ' for repo ' + repo.name);
            if (force || (await mustBeUpdated(repository, repo))) {
                !force && !fetch && console.log("Performing release for " + repo.name);
                repo.pom = await performRelease(repository, repo);
            }
        } catch (e) {
            console.log(e);
        }
    }
    return updatedRepos;
}

function getMavenRepos(currentPath) {
    !currentPath && (currentPath = localPath);
    !currentPath.endsWith('/') && (currentPath += '/');
    return new Promise(function (ok, ko) {
        fs.readdir(currentPath, async function (err, items) {
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
                if(hasPom || hasGit) {
                    mavenRepos.push({
                        path,
                        pom: hasPom && fs.readFileSync(path + configuration.fileToStageName, configuration.encoding),
                        lastCommitDate: hasGit && await getLastCommitDate(path),
                        name: hasPom ? await getProjectName(path) : path
                    });
                    try {
                        fs.unlinkSync(path + configuration.fileToStageName + '.versionsBackup');
                    } catch(e) {
                    }
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
    for(var i in directoriesToExclude) {
        if(path.indexOf(directoriesToExclude[i]) !== -1) {
            return true;
        }
    }
    return false;
}

async function mustBeUpdated(repository, repoData) {
    if(repository) {
        var mustBeUpdated = false;
        var walker = git.Revwalk.create(repository);
        walker.pushHead();
        await walker.getCommitsUntil(commit => {
            if (commit.date().getTime() > repoData.lastCommitDate && commit.message().indexOf(configuration.commitMessage) !== -1) {
                mustBeUpdated = true;
            }
            return true;
        });
        if(mustBeUpdated) {
            return true;
        }
    }
    if(repoData.pom && repoData.pom !== fs.readFileSync(repoData.path + configuration.fileToStageName, configuration.encoding)) {
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
    return new Promise(function (ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + configuration.fileToStageName, configuration.encoding), function (error, pom) {
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
    return new Promise(function (ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + configuration.fileToStageName, configuration.encoding), function (error, pom) {
            if (error) {
                ko(error);
                return;
            }
            ok(pom.project.groupId[pom.project.groupId.length - 1] + "." + pom.project.artifactId[pom.project.artifactId.length - 1]);
        });
    });
}

async function performRelease(repository, repo) {
    if(!repo.pom) {
        return;
    }
    !fetch && repository && (await commit(repository, configuration.fileToStageName));
    if(!fetch && repo.pom.indexOf('ossrh') !== -1) {
        var prepareTaskVersions = await getVersionsForPrepareTask(repo.path);
        console.log('Release task versions for ' + repo.name + ': ' + JSON.stringify(prepareTaskVersions));
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
    try {
        const mvn = maven.create({ cwd: repository, quiet: true });
        var parameters = {
            skipTests: true
        };
        prepareTaskVersions && Object.keys(prepareTaskVersions).map(key => parameters[key] = prepareTaskVersions[key]);
        console.log("Running Maven %s task for %s", task, repository);
        await mvn.execute([task], parameters);
    } catch (e) {
        console.log(e);
    }
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

    if(force) {
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

async function pullAllChanges(repository, repo) {
    if(repository) {
        try {
            await git.Reset.reset(repository, await repository.getHeadCommit(), git.Reset.TYPE.HARD);
            await repository.fetchAll(fetchOptions);
            //await repository.mergeBranches(configuration.branchName, configuration.originBranchName);
            await git.Reset.reset(repository, await repository.getBranchCommit(configuration.originBranchName), git.Reset.TYPE.HARD);
            //await repository.mergeBranches(configuration.branchName, configuration.originBranchName);
        } catch (e) {
            console.log(e);
        }
    }
    if(repo.pom) {
        await executeMaven(repo.path, 'versions:use-latest-releases');
    }
}

async function commit(repository, fileToStage) {
    console.log("Committing file " + fileToStage + " for repository.");
    try {
        var openIndex = await repository.refreshIndex();
        await openIndex.addByPath(fileToStage);
        await openIndex.write();
        var oid = await openIndex.writeTree();
        var head = await git.Reference.nameToId(repository, 'HEAD');
        var parent = await repository.getCommit(head);
        await repository.createCommit('HEAD', author, author, configuration.pushMessage, oid, [parent]);
    } catch (e) {
        console.log(e);
    }
}

async function pushAllChanges(repository, tagVersion, repo, force) {
    console.log("Pushing the new tag release " + tagVersion + " for repository " + repo.name);
    try {
        var remoteResult = await repository.getRemote('origin');
        await remoteResult.push([(force === true ? '+' : '') + configuration.branchReferenceName, (force === true ? '+' : '') + configuration.tagReferenceName + tagVersion], fetchOptions);
    } catch (e) {
        force !== true && console.log('Push failed, trying again in force mode...');
        force === true && console.log(e);
        force !== true && await pushAllChanges(repository, tagVersion, repo, true);
    }
}
// ---------------------------- MAIN -----------------------------//
main().catch(console.log);