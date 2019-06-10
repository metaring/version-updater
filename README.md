# version-updater
The MetaRing Platform - Ecosystem Version Updater

# Preparation steps before runing the script 
1. In your local machine please install:
    * [NodeJS](https://nodejs.org/en/)
    * [Java 8](https://www.oracle.com/technetwork/java/javase/downloads/jdk8-downloads-2133151.html)
    * [Maven](https://maven.apache.org/download.cgi)
2. Check that you have added JAVA_HOME environment variable 
3. Check that you have added M2_HOME environment variable
4. Run npm install to have installed all packages
5. Add in project configuration.local.json (copy and rename configuration.json) and define:
    * Public Key
    * Private Key
    * Local Project Repositories (it's quite important that all the folders are alphabetically ordered according to cascading dependencies)

# Run Script
1. If first time, lauch the `npm install` command
2. use the `npm run start` command
3. You can also use `npm run fetch` command if you want just to massive fetch & pull all projects