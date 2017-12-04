const _ = require('lodash');
const nodeID3 = require('node-id3');
const firebase = require('firebase-admin');
const request = require('bhttp');
const fs = require('fs')
const cheerio = require('cheerio');
const Promise = require('bluebird');
const sanitize = require("sanitize-filename");

const path = '/Users/jignesh/projects/musicblob/';
const gcloud = require('google-cloud')({
    projectId: 'music-blobs',
    keyFilename: `${path}firebase-admin-sdk.json`
});
const gcs = gcloud.storage();
const bucket = gcs.bucket('music-blobs.appspot.com');

const firebaseEncode = require('firebase-encode');
const firebaseConfig = {
    credential: firebase.credential.cert(require(`${path}firebase-admin-sdk.json`)),
    databaseURL: "https://music-blobs.firebaseio.com",
    databaseAuthVariableOverride: {
        uid: "service-worker"
    }
};
const app = firebase.initializeApp(firebaseConfig);

const musicDir = `${path}music/`;
const uploadChannel = 'SoundCloud';
let cachedClientId = '4LwsdPbmqbk86jdx4noywT0gRbOIbWvU';

if (!fs.existsSync(musicDir)) {
    fs.mkdirSync(musicDir);
}

function getAbsolutePath(path) {
    return `${musicDir}${path}`;
}

const scrapeClientId = async () => {
    const response = await request.get('https://soundcloud.com/charts/top?genre=jazzblues&country=all-countries')

    const $ = cheerio.load(response.body.toString());
    const scripts = _.filter($('script').get(), (script) => {
        if (script.type == 'script' && !_.isEmpty(script.attribs) && _.includes(script.attribs.src, 'assets/app-')) {
            return script;
        }
    });

    const script = await request.get(scripts[0].attribs.src);

    cachedClientId = script.body.toString().match(/client_id\:"(\w+)"/)[1];

    return cachedClientId;
}


// track module
const Track = {

    getArtist: function(track) {
        if (track.publisher_metadata && !_.isEmpty(track.publisher_metadata.artist)) {
            return track.publisher_metadata.artist;
        } else {
            return ''
        }
    },

    uploadFile: async (filePath) => {
        try {
            const results = await bucket.file(filePath).getMetadata()
            return results[0];
        } catch(err) {
            const absoluteFilePath = getAbsolutePath(filePath)
            const uploadedFile = await bucket.upload(absoluteFilePath);
            return uploadedFile.metadata
        }
    },

    downloadMusic: function(trackUrl) {
        return request.get(trackUrl, { stream: true });
    },

    getArtworkUrl: function(track) {
        let artwork_url = track.artwork_url || track.user.avatar_url

        // magnified url
        return artwork_url.replace('-large.', '-t500x500.')
    },

    addMetaTags: async (track, mp3filePath) => {
        // Get image url from the track object and
        // download the image.
        // Image tags requires local image
        const art_url = Track.getArtworkUrl(track);
        // Get the image
        const response = await request.get(art_url, { stream: true });
        const title = firebaseEncode.encode(`${track.title} ${Track.getArtist(track)}`);
        const filePath = getAbsolutePath(`${sanitize(title)}.jpg`);

        const written = await new Promise((resolve) => {
            return response
                .pipe(fs.createWriteStream(filePath))
                .on('finish', resolve);
        });

        // There is an issue if we directly try to read the jpg image
        // so delaying a little.
        await new Promise((resolve, reject) => setTimeout(() => resolve(), 1000));

        const metadata = track.publisher_metadata || {};
        const tags = {
            album: metadata.album_title,
            artist: metadata.artist,
            genre: track.genre,
            image: filePath,
            title: metadata.release_title,
        }
        nodeID3.write(tags, mp3filePath);

        return nodeID3.read(mp3filePath);
    },

    /**
     * Check if music file exists in the database
     * if exists only update hours and id.
     */
    uploadTrackIfNotInDatabase: async (track, genre) => {
        const title = firebaseEncode.encode(`${track.title} ${Track.getArtist(track)}`);
        const mp3filePath = `${sanitize(title)}.mp3`;
        let response = {};

        // Request to check if file existing in the API storage.
        snapshot = await app.database().ref(`${uploadChannel}/${genre}/${sanitize(title)}`).once('value')

        const soundtrack = {};
        const song = snapshot.val()

        // File API and mediaLink, artLink exists
        if (song && !_.isEmpty(song.mediaLink) && !_.isEmpty(song.artLink)) {
            console.log(`Skipping upload: ${genre}`)
            const soundtrack = {
                id: _.union([new Date().getTime()], snapshot.val().id),
                hours: snapshot.val().hours + 1
            };

            response = await app.database().ref(`${uploadChannel}/${genre}/${sanitize(title)}`).update(soundtrack);
        } else {
            console.log(`Processing: ${genre}`)
            response = await Track.uploadTrack(track, genre)
        }

        return response;
    },

    uploadTrack: async (track, genre) => {
        console.log(genre);
        // Steps
        // 1. Download mp3
        // 2. Upload art to bucket
        // 3. Upload music to bucket
        // 4. Update track in firebase with both links.

        let response = await request.get(`https://api.soundcloud.com/i1/tracks/${track.id}/streams?client_id=${cachedClientId}`)
        const downloadLink = response.body.http_mp3_128_url;

        console.log('Downloading music: ', genre);
        response = await Track.downloadMusic(downloadLink);

        const title = firebaseEncode.encode(`${track.title} ${Track.getArtist(track)}`);
        const filePath = getAbsolutePath(`${sanitize(title)}.mp3`);

        console.log('Storing music in local: ', genre);
        const written = await new Promise((resolve) => {
            return response
                .pipe(fs.createWriteStream(filePath))
                .on('finish', resolve);
        });

        console.log('Adding meta tags: ', genre);
        const tags = await Track.addMetaTags(track, filePath);

        console.log('Uploading music to cloud: ', genre);
        const promises = [
            Track.uploadFile(`${sanitize(title)}.jpg`),
            Track.uploadFile(`${sanitize(title)}.mp3`)
        ];

        response = await Promise.all(promises);

        console.log('Updating API: ', genre);
        const snapshot = await app.database().ref(`${uploadChannel}/${genre}/${sanitize(title)}`).once('value');
        let soundtrack = {
            src: [downloadLink],
            title: track.title,
            artist: Track.getArtist(track),
            art: Track.getArtworkUrl(track),
            posturl: [track.permalink_url],
            time: [parseInt(track.duration / 1000, 10)],
            id: [new Date().getTime()],
            hours: 1,
            mediaLink: response[1].mediaLink,
            selfLink: response[1].selfLink,
            artLink: response[0].mediaLink,
            userName: track.user ? track.user.full_name : ''
        }

        if (!_.isEmpty(snapshot.val())) {
            _.assign(soundtrack, {
                src: _.union([downloadLink], snapshot.val().src),
                id: _.union([new Date().getTime()], snapshot.val().id),
                hours: snapshot.val().hours + 1
            });
        }

        response = await app.database().ref(`${uploadChannel}/${genre}/${sanitize(title)}`).update(soundtrack);
        console.log('API updated: ', genre);
        return genre;
    }
}

/**
 * Fetch channels and upload top track
 * @return {[type]} [description]
 */
const getSoundCloudApiURLs = async () => {
    // Get channels from firebase Database
    // and create api urls out of it
    const channels = await app.database().ref('/channels').once('value')

    const channelsData = _.filter(channels.val(), (channel) => {
        return channel.service === 'SoundCloud'
    });

    const api_urls = channelsData.map((channel) => {
        let uri = `https://api-v2.soundcloud.com/charts?kind=top&limit=20&client_id=${cachedClientId}`;

        if (!_.isEmpty(channel.region) && channel.region !== 'all-countries') {
            uri = `${uri}&region=soundcloud:region:${channel.region}`
        }

        if (!_.isEmpty(channel.genre)) {
            uri = `${uri}&genre=soundcloud:genres:${channel.genre}`
        };

        return {
            uri: uri,
            genre: channel.title,
        };
    });

    return api_urls;
}


/**
 * Process urls gets the data from soundcloud API
 * and uploads the track if all good.
 */
const processUrls = async (urlsData) => {
    const promises = Promise
        .resolve(urlsData)
        .mapSeries((url, index) => {
            console.log(`Requesting data: ${url.uri}`)

            return request.get(url.uri).then((response) => {
                const topTrack = response.body.collection[0].track;
                return Track.uploadTrackIfNotInDatabase(topTrack, url.genre);
            });
        }, { concurrency: 1 });

    const responses = await Promise.all(promises);

    return responses;
}

const run = async () => {
    const cachedClientId = await scrapeClientId();
    const api_urls = await getSoundCloudApiURLs();
    const responses = await processUrls(api_urls);

    console.log('Going offline now. Good Bye!');
    app.database().goOffline();
    process.exit();
}

run();
