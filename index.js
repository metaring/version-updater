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

// Require in NodeGit, since we want to use the local copy, we're using a
// relative path.  In your project, you will use:
// var git = require("../../../");
const fs = require("fs"),
    rimraf = require("rimraf"),
    git = require("nodegit"),
    maven = require("maven"),
    xml2js = require('xml2js'),
    Enumerable = require('linq'),
    configuration = require('./configuration');

// Ensure that the `tmp` directory is local to this file and not the CWD.
var localPath = configuration.reposLocation.split('\\').join('/');
!localPath.endsWith('/') && (localPath += '/');
console.log("Project local path is: %s", localPath);

const pomVersionParser = new xml2js.Parser({ attrkey: "version" });

// Public/private keys local path's
const publicKey = fs.readFileSync(configuration.publicKeyLocation, 'utf-8'),
    privateKey = fs.readFileSync(configuration.privateKeyLocation, 'utf-8');

// Simple object to store clone options.
// fetchOpts is a required callback for OS X machines.  There is a known issue
// with libgit2 being able to verify certificates from GitHub.
var options = {
    fetchOpts: {
        callbacks: {
            credentials: function (url, userName) {
                console.log('Credentials url: %s, userName: %s', url, userName);
                // for private repository using ssh key which is added in github settings
                // return git.Cred.sshKeyFromAgent(userName);
                return git.Cred.sshKeyMemoryNew(userName, publicKey, privateKey, "");
            },
            certificateCheck: function () {
                console.log('Certificate checking in repo: %s', cloneURL);
                return 0;
            }
        }
    }
};

/***
 * Main business functionality
 * 
 * 1. Get all maven repos in localPath (containing pom.xml file and .git folder), saving the pom version file
 * 
 * 2. For each repo, check last commit message includes a change on the version tag in the pom message
 *    1.1. yes
 *       a. run maven compile to do changes in pom.xml dependency library
 *       b. git commit changes in pom.xml 
 *       c. git push changes into repository
 *    1.2. no
 *       a. exit from programm .....
 */
async function main() {
    var mavenRepos = await getMavenRepos(); Enumerable.from(mavenRepos);
    var poms = Enumerable.from(mavenRepos).where(it => it.maven).toArray();
    var repos = Enumerable.from(mavenRepos).where(it => it.repo).toArray();
    await fetchAndCompile(repos, poms);
}

async function fetchAndCompile(repos, poms) {
    for (var i in repos) {
        var repo = repos[i];
        try {
            var repository = await git.Repository.open(repo.path);
            //TODO repo Fetch
            //TODO repo Pull
            if (repo.maven && repo.oldVersion !== (await getPOMVersion(repo.path))) {
                for(var z in poms) {
                    var pom = poms[z];
                    //await mavenCompileTask(lP);
                    //TODO maven compile #1
                    //TODO maven compile #1
                
                    //TODO maven release:clean
                    //TODO maven release:prepare
                    //TODO maven release:perform
                    console.log('Changes commited and pushed into repository');
                    console.log('Doneeeeeeeeeeeeeeeeeeeeeeeeeee !!!!!!!!!!!!!!');
                }
            }
        } catch (error) {
            console.log('Error !!!!!!!!!!!!!!', error);
        }
    }
}

function getMavenRepos(currentPath) {
    !currentPath && (currentPath = localPath);
    !currentPath.endsWith('/') && (currentPath += '/');
    return new Promise(function (ok, ko) {
        var mavenRepos = [];
        fs.readdir(currentPath, async function (err, items) {
            if (err) {
                ko(err);
                return;
            }
            for (var i = 0; i < items.length; i++) {
                var path = currentPath + items[i];
                if (!fs.lstatSync(path).isDirectory() || path.endsWith('/target') || items[i].startsWith('.')) {
                    continue;
                }
                !path.endsWith('/') && (path += '/');
                var maven = fs.existsSync(path + 'pom.xml');
                var oldPom = fs.readFileSync(path + 'pom.xml', 'utf-8');
                var oldVersion = !maven ? undefined : await getPOMVersion(path);
                var repo = fs.existsSync(path + '.git/');
                (maven || repo) && mavenRepos.push({
                    path,
                    maven,
                    oldPom,
                    oldVersion,
                    repo
                });
                (await getMavenRepos(path)).map(item => mavenRepos.push(item));
            }
            ok(mavenRepos);
        });
    });
}

function getPOMVersion(path) {
    !path.endsWith('/') && (path += '/');
    return new Promise(function (ok, ko) {
        pomVersionParser.parseString(fs.readFileSync(path + 'pom.xml', 'utf-8'), function (error, pom) {
            if (error) {
                ko(error);
                return;
            }
            ok(pom.project.version[pom.project.version.length - 1]);
        });
    });
}

/***
 * Runs maven compile task to update pom.xml frameworks with new SNAPSHOT version
 */
async function mavenCompileTask(repository) {
    console.log("Maven Compilation running ... %s", repository);
    const mvn = maven.create({
        cwd: repository
    });
    await mvn.execute(['compile'], { 'skipTests': true })
        .then(() => {
            // As mvn.execute(..) returns a promise, you can use this block to continue
            // your stuff, once the execution of the command has been finished successfully.
            console.log("Maven Compilation succesfuly done ... %s ");
        })
        .catch(error => console.log("Some compilation errors happened Huston %s", error));
}

/***
 * Step commit and push: Commit and push pom.xml changes back to the repository
 */
async function commitConfigurationChanges(localFolder) {
    // TODO not working yet correctely
    var fileToStage = 'pom.xml';

    var repo, index, oid, remote;

    git.Repository.open(localPath)
        .then(function (repoResult) {
            console.log('Open Index ....', localFolder.openIndex())
            repo = repoResult;
            return repoResult.openIndex();
        })
        .then(function (indexResult) {
            console.log('Index Result ....', indexResult)
            index = indexResult;

            // this file is in the root of the directory and doesn't need a full path
            index.addByPath(fileToStage);

            // this will write files to the index
            index.write();

            return index.writeTree();
        })
        .then(function (oidResult) {
            oid = oidResult;

            return git.Reference.nameToId(repo, 'HEAD');
        })
        .then(function (head) {
            return repo.getCommit(head);
        })
        .then(function (parent) {
            author = git.Signature.now('Author Name', 'haik.hovhannisyan@email.com');
            committer = git.Signature.now('Commiter Name', 'haik.hovhannisyan@email.com');

            return repo.createCommit('HEAD', author, committer, 'Added the Readme file for theme builder', oid, [parent]);
        })
        .then(function (commitId) {
            return console.log('New Commit: ', commitId);
        })

        /// PUSH
        .then(function () {
            console.log('PUSH .........')
            return repo.getRemote('origin');
        })
        .then(function (remoteResult) {
            console.log('remote Loaded');
            remote = remoteResult;
            remote.setCallbacks(options);
            // remote.setCallbacks({
            //     credentials: function(url, userName) {
            //         return git.Cred.sshKeyFromAgent(userName);
            //     }
            // });
            console.log('remote Configured');

            return remote.connect(git.Enums.DIRECTION.PUSH);
        })
        .then(function () {
            console.log('remote Connected?', remote.connected())

            return remote.push(
                ['refs/heads/master:refs/heads/master'],
                null,
                repo.defaultSignature(),
                'Push to master'
            )
        })
        .then(function () {
            console.log('remote Pushed!')
        })
        .catch(function (reason) {
            console.log(reason);
        })
}

// ---------------------------- MAIN -----------------------------//
main().catch(console.error);